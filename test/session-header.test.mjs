/**
 * Core tests for `lib/session-header.js`.
 *
 * The core is transport-free by design, so everything here runs against plain
 * objects — no Cordis, no pi-ai, no network. The fakes are classes, not object
 * literals, because the real `ModelsImpl#streamSimple` and
 * `PiAiAdapter#streamWithSnapshot` are prototype methods: a hook installed on an
 * object literal would exercise a different restore path than the one that
 * ships.
 *
 * Two disciplines are deliberate:
 *
 *   - **Counters prove the branch ran.** Every claim that "the header was
 *     added" is paired with a counter or a spy count, because the failure mode
 *     this suite exists to catch is a wrapper that silently early-returns and
 *     leaves a green suite behind.
 *   - **The negative control comes first.** The scope is the feature that
 *     matters most here: the suite asserts, on every positive case, that a
 *     neighbouring route and a neighbouring protocol are left alone.
 *
 * @module dsh-opencode-session-header/test/session-header
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySessionHeader,
  createSessionHeader,
  defaultConfig,
  HEADER_NAME,
  headerNameFor,
  instrumentAdapter,
  instrumentModels,
  isScopedRoute,
  resolveConfig,
  SCOPED_ROUTES,
  sessionHeaderValue,
  SessionHeaderError,
} from '../lib/session-header.js';

const SESSION = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe';
const UUID = '05681fd4-1667-4f46-874f-11fd7f10abbe';
const OTHER_SESSION = 'session-11111111-2222-3333-4444-555555555555';

/** One fake pi-ai model collection, shaped like `ModelsImpl`. */
class FakeModels {
  constructor(model = { id: 'probe-model', provider: 'opencode-go', api: 'openai-completions' }) {
    this.model = model;
    this.calls = [];
  }

  getModel() {
    return this.model;
  }

  streamSimple(model, context, options) {
    this.calls.push({ model, context, options });
    return { done: true };
  }
}

/** One fake adapter, shaped like `PiAiAdapter`. */
class FakeAdapter {
  constructor(models) {
    this.models = models;
    this.calls = [];
  }

  streamWithSnapshot(options, snapshot) {
    this.calls.push(options);
    const models = snapshot?.models ?? this.models;
    models.streamSimple(models.getModel(), [], { sessionId: options.sessionId });
    return { done: true };
  }
}

/** Counters as `applySessionHeader` expects them. */
const freshStats = () => ({ calls: 0, scoped: 0, attached: 0, sessionless: 0, outOfScope: 0, inherited: 0 });

/** A registry shaped like the LLM runtime's route map. */
function fakeRegistry(entries) {
  return new Map(entries.map(([route, adapter]) => [route, { adapter, provider: { id: route, name: route }, retryPolicy: {} }]));
}

test('the scope is a fixed whitelist of the two OpenCode routes', () => {
  assert.deepEqual(SCOPED_ROUTES, ['opencode-go', 'opencode-go-custom']);
  assert.equal(HEADER_NAME, 'x-opencode-session');
  assert.equal(isScopedRoute('opencode-go'), true);
  assert.equal(isScopedRoute('opencode-go-custom'), true);
  assert.equal(isScopedRoute('OpenCode-Go'), true, 'route keys are matched case-insensitively');
  assert.equal(isScopedRoute('opencode-go-eu'), false, 'a route that merely resembles the gateway is out');
  assert.equal(isScopedRoute('opencode-zen'), false);
  assert.equal(isScopedRoute('my-opencode-go'), false);
  assert.equal(isScopedRoute('deepseek'), false);
  assert.equal(isScopedRoute(undefined), false);
});

test('resolveConfig: defaults reproduce the operation this plugin replaces', () => {
  const config = resolveConfig(undefined);
  assert.deepEqual(config, defaultConfig());
  assert.deepEqual(Object.keys(config).sort(), ['enabled', 'sessionlessFallback', 'value']);
  assert.equal(config.enabled, true);
  assert.equal(config.value, 'auto');
  assert.equal(config.sessionlessFallback, true);
});

test('resolveConfig: the scope cannot be configured, and typos are rejected', () => {
  for (const key of ['routes', 'optInRoutes', 'skipApis', 'header', 'scope']) {
    assert.throws(() => resolveConfig({ [key]: ['opencode*'] }), (error) => {
      assert.ok(error instanceof SessionHeaderError);
      assert.equal(error.code, 'opencode-session-header/invalid-config');
      assert.match(error.message, new RegExp(`unknown config key "${key}"`));
      assert.match(error.message, /only opencode-go and opencode-go-custom models receive x-opencode-session/);
      return true;
    }, `${key} must not be configurable`);
  }
  assert.throws(() => resolveConfig({ optinRoutes: ['x'] }), /unknown config key "optinRoutes"/, 'a typo is an error, not a silent no-op');
  assert.throws(() => resolveConfig({ value: 'bare' }), /config\.value must be one of/);
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /config\.enabled must be a boolean/);
  assert.throws(() => resolveConfig({ sessionlessFallback: 'no' }), /config\.sessionlessFallback must be a boolean/);
  assert.throws(() => resolveConfig(['opencode*']), /config must be an object/);
});

test('headerNameFor: only the whitelisted routes are in scope', () => {
  const config = resolveConfig(undefined);
  assert.equal(headerNameFor({ provider: 'opencode-go', api: 'openai-completions' }, config), HEADER_NAME);
  assert.equal(headerNameFor({ provider: 'opencode-go-custom', api: 'openai-responses' }, config), HEADER_NAME);
  assert.equal(headerNameFor({ provider: 'opencode-zen', api: 'openai-completions' }, config), undefined);
  assert.equal(headerNameFor({ provider: 'deepseek', api: 'openai-completions' }, config), undefined);
  assert.equal(headerNameFor({}, config), undefined, 'a descriptor with no route is out of scope');
  assert.equal(headerNameFor({ provider: 'opencode-go', api: 'openai-completions' }, resolveConfig({ enabled: false })), undefined);
});

test('sessionHeaderValue: `auto` follows pi-ai where pi-ai already sends a session header', () => {
  assert.equal(sessionHeaderValue(SESSION, 'openai-completions', 'uuid'), UUID);
  assert.equal(sessionHeaderValue(SESSION, 'openai-completions', 'id'), SESSION);
  assert.equal(sessionHeaderValue(SESSION, 'openai-completions', 'auto'), UUID);
  assert.equal(sessionHeaderValue(SESSION, 'anthropic-messages', 'auto'), UUID);
  assert.equal(
    sessionHeaderValue(SESSION, 'openai-responses', 'auto'),
    SESSION,
    'opencode-go-custom is openai-responses, so both headers must name the same conversation',
  );
  assert.equal(sessionHeaderValue(UUID, 'openai-completions', 'auto'), UUID, 'an unprefixed id is already bare');
});

test('applySessionHeader: negative control, then the attached header', () => {
  const config = resolveConfig(undefined);
  const stats = freshStats();
  const options = { sessionId: SESSION, headers: { 'user-agent': 'deepseek-harness/1' } };

  const untouched = applySessionHeader({ provider: 'opencode-zen', api: 'openai-completions' }, options, config, stats);
  assert.equal(untouched, options, 'an out-of-scope call is returned by identity, with no allocation');
  assert.equal(untouched.headers[HEADER_NAME], undefined, 'control: nothing is added outside the whitelist');
  assert.equal(stats.outOfScope, 1);
  assert.equal(stats.scoped, 0);

  const attached = applySessionHeader({ provider: 'opencode-go', api: 'openai-completions' }, options, config, stats);
  assert.notEqual(attached, options, 'the adapter-owned object is never mutated');
  assert.equal(options.headers[HEADER_NAME], undefined, 'the original stays untouched');
  assert.equal(attached.headers[HEADER_NAME], UUID);
  assert.equal(attached.headers['user-agent'], 'deepseek-harness/1', 'the Harness attribution survives');
  assert.equal(attached.sessionId, SESSION);
  assert.deepEqual({ calls: stats.calls, scoped: stats.scoped, attached: stats.attached }, { calls: 2, scoped: 1, attached: 1 });
  assert.deepEqual(
    { provider: stats.last.provider, api: stats.last.api, header: stats.last.header, source: stats.last.source },
    { provider: 'opencode-go', api: 'openai-completions', header: HEADER_NAME, source: 'request' },
  );
  assert.match(stats.last.value, /^05681fd4/, 'the report carries a readable value');
  assert.ok(stats.last.value.length < UUID.length && stats.last.value.endsWith('…'), 'and masks its tail');
});

test('applySessionHeader: the custom route is labelled the same way', () => {
  const config = resolveConfig(undefined);
  const stats = freshStats();
  const attached = applySessionHeader(
    { provider: 'opencode-go-custom', api: 'openai-responses' },
    { sessionId: SESSION, headers: {} },
    config,
    stats,
  );
  assert.equal(attached.headers[HEADER_NAME], SESSION, 'auto mode keeps the raw id next to pi-ai\'s own session_id');
});

test('applySessionHeader: a same-named static entry is replaced, whatever its case', () => {
  const config = resolveConfig(undefined);
  const attached = applySessionHeader(
    { provider: 'opencode-go', api: 'openai-completions' },
    { sessionId: SESSION, headers: { 'X-Opencode-Session': 'static-value', accept: 'application/json' } },
    config,
    freshStats(),
  );
  assert.deepEqual(attached.headers, { accept: 'application/json', [HEADER_NAME]: UUID });
  assert.equal(attached.headers['X-Opencode-Session'], undefined);
});

test('applySessionHeader: a call with no conversation gets no fabricated value', () => {
  const config = resolveConfig(undefined);
  const stats = freshStats();
  const options = { headers: { [HEADER_NAME]: 'static-value' } };
  const returned = applySessionHeader({ provider: 'opencode-go', api: 'openai-completions' }, options, config, stats);
  assert.equal(returned, options);
  assert.equal(returned.headers[HEADER_NAME], 'static-value', 'the deployment static value survives');
  assert.equal(stats.sessionless, 1);
  assert.equal(stats.attached, 0);
});

test('applySessionHeader: the initiator fallback fires only when configured', () => {
  const model = { provider: 'opencode-go-custom', api: 'anthropic-messages' };
  const fallback = () => SESSION;

  const offStats = freshStats();
  const off = resolveConfig({ sessionlessFallback: false });
  assert.equal(applySessionHeader(model, {}, off, offStats, fallback).headers, undefined, 'off: the fallback is never consulted');
  assert.equal(offStats.sessionless, 1);
  assert.equal(offStats.inherited, 0);

  const on = resolveConfig(undefined);
  const onStats = freshStats();
  const attached = applySessionHeader(model, {}, on, onStats, fallback);
  assert.equal(attached.headers[HEADER_NAME], UUID);
  assert.equal(onStats.inherited, 1);
  assert.equal(onStats.sessionless, 0);
  assert.equal(onStats.last.source, 'initiator');

  const absent = freshStats();
  const noInitiator = applySessionHeader(model, {}, on, absent, () => undefined);
  assert.equal(noInitiator.headers, undefined, 'a missing initiator still fabricates nothing');
  assert.equal(absent.sessionless, 1);
});

test('instrumentModels: wraps once, chains honestly, and restores exactly', () => {
  const config = resolveConfig(undefined);
  const stats = freshStats();
  const models = new FakeModels();
  const prototypeMethod = models.streamSimple;
  let decideCalls = 0;
  const decide = (model, options) => {
    decideCalls += 1;
    return applySessionHeader(model, options, config, stats);
  };

  const first = instrumentModels(models, decide);
  const second = instrumentModels(models, decide);
  assert.equal(second, first, 'a second instrumentation is a no-op, so the chain cannot grow');
  assert.notEqual(models.streamSimple, prototypeMethod);

  models.streamSimple({ provider: 'opencode-go', api: 'openai-completions' }, [], { sessionId: SESSION, headers: {} });
  assert.equal(decideCalls, 1, 'the wrapper ran exactly once for one call');
  assert.equal(models.calls.at(-1).options.headers[HEADER_NAME], UUID);

  first.restore();
  assert.equal(models.streamSimple, prototypeMethod, 'the prototype method is visible again');
  assert.equal(Object.prototype.hasOwnProperty.call(models, 'streamSimple'), false, 'and the own property is gone');

  const third = instrumentModels(models, decide);
  assert.notEqual(third, first, 'a fresh hook installs a fresh record');
  third.restore();
});

test('instrumentModels: an own property installed by someone else is preserved on restore', () => {
  const config = resolveConfig(undefined);
  const stats = freshStats();
  const upstream = () => ({ upstream: true });
  const models = new FakeModels();
  models.streamSimple = upstream;
  const record = instrumentModels(models, (model, options) => applySessionHeader(model, options, config, stats));
  assert.notEqual(models.streamSimple, upstream);
  record.restore();
  assert.equal(models.streamSimple, upstream, 'the pre-existing own property comes back, not the prototype method');
});

test('instrumentAdapter: reaches every collection the adapter hands out, and nothing else', () => {
  const config = resolveConfig(undefined);
  const stats = freshStats();
  const decide = (model, options) => applySessionHeader(model, options, config, stats);
  const models = new FakeModels();
  const adapter = new FakeAdapter(models);
  const hooked = [];
  const record = instrumentAdapter(adapter, decide, (collection) => hooked.push(collection));
  assert.notEqual(record, undefined);
  assert.equal(instrumentAdapter(adapter, decide), record, 'hooking twice returns the same record');
  assert.equal(instrumentAdapter({ stream: () => {} }, decide), undefined, 'a non-pi-ai adapter is left alone');
  assert.equal(instrumentAdapter(null, decide), undefined);

  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(hooked.length, 1, 'the collection was instrumented on the way through');
  assert.equal(hooked[0], models);
  assert.equal(models.calls.at(-1).options.headers[HEADER_NAME], UUID);

  assert.equal(models.calls.length, 1);
  record.restore();
  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(models.calls.length, 2, 'the call still reaches the model collection');
  assert.equal(models.calls.at(-1).options.headers, undefined, 'but the retired hook no longer transforms options');
});

test('createSessionHeader: one sweep hooks the pi-ai adapter, and the scope still decides', (t) => {
  const models = new FakeModels();
  const adapter = new FakeAdapter(models);
  const foreign = { stream: () => {}, providerInfo: () => ({ id: 'x', name: 'x' }) };
  const classMethod = FakeAdapter.prototype.streamWithSnapshot;
  const core = createSessionHeader(undefined);
  t.after(() => core.dispose());

  assert.equal(core.hookRegistry(new Map()), 0, 'an empty registry hooks nothing');
  const hooked = core.hookRegistry(fakeRegistry([['opencode-go', adapter], ['deepseek', foreign]]));
  assert.equal(hooked, 1, 'only the pi-ai shaped adapter is hooked');
  assert.equal(core.status().hooked.adapters, 1);
  assert.deepEqual(core.status().hooked.routes, ['deepseek', 'opencode-go'], 'the report names every route the registry holds');
  assert.deepEqual(core.status().hooked.routesInScope, ['opencode-go']);

  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(models.calls.at(-1).options.headers[HEADER_NAME], UUID);
  assert.equal(core.status().hooked.collections, 1, 'the status report counts the instrumented collection');

  // The class itself was instrumented as well, so a later adapter instance —
  // what an HMR reload builds — is covered without another sweep.
  const laterModels = new FakeModels();
  new FakeAdapter(laterModels).streamWithSnapshot({ provider: 'opencode-go', sessionId: OTHER_SESSION }, { models: laterModels });
  assert.equal(laterModels.calls.at(-1).options.headers[HEADER_NAME], '11111111-2222-3333-4444-555555555555', 'two conversations get two values');
  assert.equal(core.status().hooked.adapters, 1, 'hooking once per instance, not once per call');

  // A model outside the whitelist, reached through the very same hooked
  // adapter, must be untouched.
  const otherModels = new FakeModels({ id: 'deepseek-chat', provider: 'deepseek', api: 'openai-completions' });
  adapter.streamWithSnapshot({ provider: 'deepseek', sessionId: SESSION }, { models: otherModels });
  assert.equal(otherModels.calls.at(-1).options.headers, undefined, 'a non-whitelisted model on a hooked adapter gets nothing');

  core.dispose();
  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(models.calls.at(-1).options.headers, undefined, 'dispose restores the adapter and the collection');
  assert.equal(Object.prototype.hasOwnProperty.call(models, 'streamSimple'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(adapter, 'streamWithSnapshot'), false);
  assert.equal(FakeAdapter.prototype.streamWithSnapshot, classMethod, 'and the class method is the original again');
});

test('createSessionHeader: a registry without a scoped route is reported', (t) => {
  const messages = [];
  const core = createSessionHeader(undefined, { log: (level, message) => messages.push(`${level}: ${message}`) });
  t.after(() => core.dispose());
  const adapter = new FakeAdapter(new FakeModels());
  assert.equal(core.hookRegistry(fakeRegistry([['deepseek', adapter]])), 1, 'the adapter is still hooked…');
  assert.match(messages.at(-1), /no route in the LLM registry names opencode-go or opencode-go-custom/, '…and the missing scope is reported');
  assert.deepEqual(core.status().hooked.routesInScope, []);
});

test('createSessionHeader: an unreachable registry is reported, never assumed benign', () => {
  const messages = [];
  const core = createSessionHeader(undefined, { log: (level, message) => messages.push(`${level}: ${message}`) });
  assert.equal(core.hookRegistry(undefined), 0);
  assert.equal(core.hookRegistry({}), 0);
  const status = core.status();
  assert.equal(status.hooked.adapters, 0);
  assert.match(status.diagnostics.at(-1).message, /NO session header is being added/);
  assert.equal(messages.filter((line) => line.startsWith('error:')).length, 2, 'every failed sweep is reported');
});

test('createSessionHeader: a throwing log sink cannot break the model path', () => {
  const core = createSessionHeader(undefined, { log: () => { throw new Error('sink is broken'); } });
  assert.equal(core.hookRegistry(undefined), 0);
  assert.match(core.status().diagnostics.at(-1).message, /NO session header/);
});

test('createSessionHeader: the status report is JSON-safe and previews every decision', () => {
  const core = createSessionHeader(undefined);
  const status = core.status();
  assert.equal(status.name, 'dsh-opencode-session-header');
  assert.equal(status.header, HEADER_NAME);
  assert.deepEqual(status.scope, SCOPED_ROUTES);
  assert.deepEqual(Object.keys(status.counters).sort(), ['attached', 'calls', 'inherited', 'last', 'outOfScope', 'scoped', 'sessionless']);
  assert.equal(status.preview.length, SCOPED_ROUTES.length * 3, 'every scoped route × protocol pair is previewed');
  const completions = status.preview.find((entry) => entry.api === 'openai-completions');
  const responses = status.preview.find((entry) => entry.api === 'openai-responses');
  assert.equal(completions.header, HEADER_NAME);
  assert.equal(completions.value, '<uuid>', 'the preview reads as the shape of the value, not one conversation');
  assert.equal(responses.value, 'session-<uuid>', 'openai-responses gets the raw id shape, matching pi-ai');
  assert.equal(JSON.parse(JSON.stringify(status)).name, 'dsh-opencode-session-header', 'the report survives a round trip');

  const disabled = createSessionHeader({ enabled: false }).status();
  assert.equal(disabled.preview.every((entry) => entry.header === null), true, 'a disabled plugin previews as inert');
});

test('createSessionHeader: `enabled: false` is diagnose-able and inert', (t) => {
  const core = createSessionHeader({ enabled: false });
  t.after(() => core.dispose());
  const models = new FakeModels();
  const adapter = new FakeAdapter(models);
  core.hookRegistry(fakeRegistry([['opencode-go', adapter]]));
  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(models.calls.length, 1, 'the call still went through');
  assert.equal(models.calls.at(-1).options.headers, undefined, 'a disabled plugin adds nothing even while hooked');
  assert.deepEqual({ calls: core.status().counters.calls, outOfScope: core.status().counters.outOfScope }, { calls: 1, outOfScope: 1 });
});
