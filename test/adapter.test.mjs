/**
 * Integration tests against the **real installed** `@deepseek-ai/dsh-llm-pi-ai`
 * adapter and pi-ai's own `fauxProvider`.
 *
 * Nothing here is a reimplementation of the plugin's logic against a mock of the
 * adapter: the adapter is the bundle this machine's `dsh` loads, and pi-ai's
 * `fauxProvider` is pi-ai's supported test seam. The faux response factory
 * receives the exact `SimpleStreamOptions` the adapter built, and that object's
 * `headers` map is the very argument pi-ai's protocol implementations merge into
 * the HTTP client's headers last (`Object.assign(headers, optionsHeaders)` in
 * `openai-completions.js`, `mergeClientHeaders(..., optionsHeaders)` in
 * `anthropic-messages.js`). An assertion on that map is therefore an assertion
 * on the header channel the gateway actually sees — the same seam the
 * deployment-wide patch script used to verify itself.
 *
 * The control case runs the same adapter, the same routes and the same
 * conversation with the hook removed, so no later assertion can pass because of
 * something the environment already did.
 *
 * Run: node test/adapter.test.mjs   (set DSH_ROOT to point at another install)
 *
 * @module dsh-opencode-session-header/test/adapter
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSessionHeader, HEADER_NAME } from '../lib/session-header.js';

const SESSION = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe';
const UUID = '05681fd4-1667-4f46-874f-11fd7f10abbe';
const OTHER = 'session-11111111-2222-3333-4444-555555555555';

/**
 * Locate the DSH install whose adapter this process would load.
 *
 * `DSH_ROOT` wins; otherwise the running interpreter's own `node_modules` is the
 * authoritative guess (a global install puts `@deepseek-ai/dsh` next to the
 * `node` binary that launches it). An install that cannot be found is a hard
 * failure, not a skipped test: this suite is the plugin's evidence.
 *
 * @returns the absolute DSH package root.
 */
function resolveDshRoot() {
  const candidates = [
    process.env.DSH_ROOT,
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const root of candidates) {
    if (existsSync(join(root, 'lib', 'bin.js'))) return root;
  }
  throw new Error(`could not locate the DSH install; tried:\n  ${candidates.join('\n  ')}`);
}

const DSH_ROOT = resolveDshRoot();
const pi = await import(pathToFileURL(join(DSH_ROOT, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js')).href);
const { PiAiAdapter } = await import(pathToFileURL(join(DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')).href);

/**
 * One faux provider on one route, recording the request options pi-ai receives.
 *
 * pi-ai's faux core shifts exactly one queued response per call and answers an
 * exhausted queue with an error message, so the recorder is queued many times
 * over: every call in a test is otherwise invisible, and `take()` would report a
 * stale map. `calls()` is what makes that impossible to miss — a test that
 * expects a second observation asserts the second call really happened.
 *
 * @param id - the route key, which the adapter uses as the provider key too.
 * @param api - the wire protocol to declare for the route's model.
 * @returns the probe: the registered provider, the captured headers, and a call count.
 */
function probe(id, api) {
  const faux = pi.fauxProvider({ provider: id, api, models: [{ id: 'probe-model' }] });
  let captured;
  let calls = 0;
  const recorder = (_context, options) => {
    calls += 1;
    captured = options?.headers;
    return pi.fauxAssistantMessage('ok');
  };
  faux.setResponses(Array.from({ length: 16 }, () => recorder));
  const model = faux.getModel('probe-model');
  model.provider = id;
  model.api = api;
  return {
    provider: faux.provider,
    take: () => captured,
    calls: () => calls,
    state: faux.state,
  };
}

/** A resolved profile with every field the adapter reads. */
function profile(routeId, provider) {
  return {
    provider: routeId,
    displayName: routeId,
    streamIdleTimeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1 },
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  };
}

/**
 * A registry entry shaped like the LLM runtime's route map, as the plugin reads
 * it during a sweep.
 * @param adapter - the adapter instance serving the routes.
 * @param routes - the route keys to publish.
 * @returns the Map the sweep consumes.
 */
function registryOf(adapter, routes) {
  return new Map(routes.map((id) => [id, { adapter, provider: { id, name: id }, retryPolicy: {} }]));
}

/**
 * Build one real adapter serving every given route, sweep it the way the plugin
 * does, and return a driver for one model call.
 *
 * @param routes - `[routeId, api]` pairs, all served by the same adapter instance.
 * @param raw - the plugin configuration to install.
 * @returns the adapter, the probes, the core, and `turn()`.
 */
function harness(routes, raw) {
  const probes = new Map(routes.map(([id, api]) => [id, probe(id, api)]));
  const profiles = new Map(routes.map(([id]) => [id, profile(id, probes.get(id).provider)]));
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('probe-key'),
  });
  const core = createSessionHeader(raw);
  const hooked = core.hookRegistry(registryOf(adapter, routes.map(([id]) => id)));
  return {
    adapter,
    core,
    hooked,
    probes,
    /** Drain one model call, exactly as the LLM runtime would. */
    async turn(routeId, sessionId) {
      for await (const _chunk of adapter.stream({
        provider: routeId,
        model: 'probe-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: AbortSignal.timeout(10_000),
        ...(sessionId === undefined ? {} : { sessionId }),
      })) {
        // Drain: the request is dispatched on the first pull.
      }
    },
    headersFor(routeId) {
      return probes.get(routeId).take();
    },
    /** How many model calls the faux provider actually observed on one route. */
    callsFor(routeId) {
      return probes.get(routeId).calls();
    },
  };
}

test('the real adapter and pi-ai loaded', () => {
  assert.equal(typeof PiAiAdapter, 'function', 'PiAiAdapter must be a constructor in the installed bundle');
  assert.equal(typeof pi.fauxProvider, 'function', 'pi-ai must expose its fauxProvider test seam');
});

test('control, then the same call with the hook: only the hook changes the headers', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  assert.equal(app.hooked, 1, 'the installed adapter is pi-ai shaped and hookable');

  app.core.dispose();
  await app.turn('opencode-go', SESSION);
  const control = app.headersFor('opencode-go');
  assert.equal(app.callsFor('opencode-go'), 1, 'the faux provider really served the call');
  assert.ok(control !== undefined, 'the faux provider saw a request');
  assert.equal(control[HEADER_NAME], undefined, 'control: nothing in the environment adds the header on its own');
  assert.equal(String(control['user-agent']).startsWith('deepseek-harness/'), true, 'the Harness attribution is present, as the adapter contract requires');

  app.core.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  await app.turn('opencode-go', SESSION);
  assert.equal(app.callsFor('opencode-go'), 2, 'and it really served the second call too, so the reading below is fresh');
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID, 'the same real call now carries the header');
  assert.equal(String(app.headersFor('opencode-go')['user-agent']).startsWith('deepseek-harness/'), true, 'the attribution still wins its reserved names');
  assert.equal(app.core.status().counters.attached, 1);
  assert.equal(app.core.status().counters.outOfScope, 0);
});

test('every opencode-go… route and its protocols are covered', async (t) => {
  const cases = [
    ['opencode-go', 'anthropic-messages', UUID],
    ['opencode-go-custom', 'openai-completions', UUID],
    ['opencode-go-eu', 'openai-completions', UUID],
    // `auto` follows pi-ai on a Responses route, whose own session_id is
    // `session-<uuid>`: one conversation, one value, one routing bucket.
    ['opencode-go-custom', 'openai-responses', SESSION],
    ['opencode-go', 'openai-responses', SESSION],
  ];
  for (const [routeId, api, expected] of cases) {
    const app = harness([[routeId, api]], undefined);
    try {
      await app.turn(routeId, SESSION);
      assert.equal(app.headersFor(routeId)[HEADER_NAME], expected, `${routeId} / ${api}`);
    } finally {
      app.core.dispose();
    }
  }
});

test('the prefix decides on the real adapter: siblings in, neighbours out', async (t) => {
  const routes = [
    ['opencode-go', 'openai-completions'],
    ['opencode-go-eu', 'openai-completions'],
    ['opencode-zen', 'openai-completions'],
    ['my-opencode-go', 'openai-completions'],
    ['deepseek', 'openai-completions'],
  ];
  const app = harness(routes, undefined);
  t.after(() => app.core.dispose());
  assert.equal(app.hooked, 1, 'one adapter serves all five routes');
  for (const [routeId] of routes) await app.turn(routeId, SESSION);
  for (const routeId of ['opencode-go', 'opencode-go-eu']) {
    assert.equal(app.headersFor(routeId)[HEADER_NAME], UUID, `${routeId} begins with the prefix and must be labelled`);
  }
  for (const routeId of ['opencode-zen', 'my-opencode-go', 'deepseek']) {
    assert.equal(app.headersFor(routeId)[HEADER_NAME], undefined, `${routeId} must be left alone`);
  }
  const counters = app.core.status().counters;
  assert.equal(counters.attached, 2);
  assert.equal(counters.outOfScope, 3, 'every out-of-scope call was counted, not silently ignored');
});

test('value mode: uuid and id override, and auto follows the protocol', async () => {
  for (const [config, expected] of [[{ value: 'uuid' }, UUID], [{ value: 'id' }, SESSION], [{ value: 'auto' }, SESSION]]) {
    const app = harness([['opencode-go-custom', 'openai-responses']], config);
    try {
      await app.turn('opencode-go-custom', SESSION);
      assert.equal(app.headersFor('opencode-go-custom')[HEADER_NAME], expected, `value mode ${config.value}`);
    } finally {
      app.core.dispose();
    }
  }
});

test('a sessionless call is labelled from the conversation only when allowed', async (t) => {
  const app = harness([['opencode-go', 'anthropic-messages']], undefined);
  t.after(() => app.core.dispose());

  // (a) The plugin's own sweep has no initiator seam: nothing is fabricated.
  await app.turn('opencode-go', undefined);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
  assert.equal(app.core.status().counters.sessionless, 1);
  app.core.dispose();

  // (b) The host half wires `agents.currentInitiator()` as that seam; here it is
  // a stub returning the conversation that is in flight.
  const withFallback = createSessionHeader(undefined, { fallback: () => SESSION });
  t.after(() => withFallback.dispose());
  withFallback.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  await app.turn('opencode-go', undefined);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID, 'the conversation id is borrowed, never invented');
  assert.equal(withFallback.status().counters.inherited, 1);
  withFallback.dispose();

  // (c) Switched off, the seam is never consulted.
  const refused = createSessionHeader({ sessionlessFallback: false }, { fallback: () => SESSION });
  t.after(() => refused.dispose());
  refused.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  await app.turn('opencode-go', undefined);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
  assert.equal(refused.status().counters.inherited, 0);
  assert.equal(refused.status().counters.sessionless, 1);
});

test('the prepared-call path the agent loop uses is covered too', async (t) => {
  // `LlmRuntime.prepareCall` binds a snapshot at preparation time and dispatches
  // through the adapter's own `stream`, which resolves `this.streamWithSnapshot`
  // at call time — so the hook installed on the instance is on the loop's path,
  // not merely on the direct `stream()` entry point.
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  const prepared = await app.adapter.prepareCall('opencode-go', 'probe-model');
  assert.equal(typeof prepared.stream, 'function');
  for await (const _chunk of prepared.stream({
    provider: 'opencode-go',
    model: 'probe-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: AbortSignal.timeout(10_000),
    sessionId: SESSION,
  })) {
    // Drain.
  }
  assert.equal(app.callsFor('opencode-go'), 1);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID);
});

test('two conversations get two values, and re-sweeping does not stack hooks', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  // A second sweep — another registry event, an HMR reload — must not install a
  // second wrapper, and must not produce a duplicated header value.
  app.core.hookRegistry(registryOf(app.adapter, ['opencode-go']));
  assert.equal(app.core.status().hooked.adapters, 1);
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID);
  await app.turn('opencode-go', OTHER);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], '11111111-2222-3333-4444-555555555555');
  assert.equal(app.core.status().counters.attached, 2);
});

test('dispose removes the header from the real adapter again', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], undefined);
  t.after(() => app.core.dispose());
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], UUID);
  app.core.dispose();
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined, 'an unloaded plugin leaves no trace');
});

test('`enabled: false` is inert on the real adapter too', async (t) => {
  const app = harness([['opencode-go', 'openai-completions']], { enabled: false });
  t.after(() => app.core.dispose());
  await app.turn('opencode-go', SESSION);
  assert.equal(app.headersFor('opencode-go')[HEADER_NAME], undefined);
  assert.equal(app.core.status().counters.outOfScope, 1);
});
