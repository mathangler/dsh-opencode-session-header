/**
 * Host-half tests: the plugin's publication contract, its wiring into a Cordis
 * context, and the diagnostic endpoint's protocol.
 *
 * The context stub mirrors the parts of Cordis this plugin actually uses
 * (`llm`, `logger`, `on`, `effect`, `inject`) so the wiring is exercised for
 * real — including the two optional injections, which must degrade to
 * "the header still works, there is just nowhere to publish the status".
 *
 * The static checks are not decoration. A plugin installed with
 * `dsh plugin add file:<dir>` is *linked* into the profile and resolves modules
 * from its own directory, so a bare `import '@deepseek-ai/...'` in `lib/` would
 * break at load time in the one place it matters. That invariant is asserted
 * here rather than trusted.
 *
 * @module dsh-opencode-session-header/test/host
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, CHANNEL, inject, name, resolveAdapterRegistry, SWEEP_RETRY_MS } from '../lib/index.js';
import { HEADER_NAME, SCOPED_ROUTES } from '../lib/session-header.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const SESSION = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe';
const UUID = '05681fd4-1667-4f46-874f-11fd7f10abbe';

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
  }

  streamWithSnapshot(options, snapshot) {
    const models = snapshot?.models ?? this.models;
    // The real adapter resolves the model for the requested route, so the model
    // the collection sees carries that route — which is what the scope reads.
    models.streamSimple({ ...models.getModel(), provider: options.provider }, [], { sessionId: options.sessionId });
    return { done: true };
  }
}

/**
 * A Cordis context stub covering exactly the surface this plugin uses.
 * @param services - the services to publish (`llm`, `webServer`, `connection`, `agents`).
 * @returns the stub, plus the recorded logs, effects, listeners and routes.
 */
function fakeCtx(services = {}) {
  const logs = [];
  const effects = [];
  const listeners = [];
  const routes = [];
  const ctx = {
    llm: services.llm,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    /** Cordis events are registered globally by this plugin; nothing to scope. */
    on(event, handler, options) {
      listeners.push({ event, handler, options });
      return () => {};
    },
    /** Register one effect and keep its disposer reachable, as Cordis would. */
    effect(fn, label) {
      effects.push({ label, dispose: fn() });
      return () => {};
    },
    get(service) {
      return services[service];
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (!list.every((service) => services[service] !== undefined)) return;
      callback(Object.assign(Object.create(ctx), Object.fromEntries(list.map((service) => [service, services[service]]))));
    },
    logs,
    effects,
    listeners,
    routes,
  };
  return ctx;
}

/** A response stub capturing status, headers and body. */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = value;
    },
    end(body) {
      res.body = body ?? '';
    },
  };
  return res;
}

/**
 * Everything the plugin needs to hook a real-shaped adapter, with a
 * configurable trust fence.
 *
 * @param rejection - what `connection.requestRejection` answers for one request.
 * @param raw - the plugin configuration.
 * @returns the context stub, the fakes, the registry, and the published routes.
 */
function bootWith(rejection, raw) {
  const models = new FakeModels();
  const adapter = new FakeAdapter(models);
  const llm = {
    adapters: new Map([
      ['opencode-go', { adapter, provider: { id: 'opencode-go', name: 'opencode-go' }, retryPolicy: {} }],
      ['deepseek', { adapter, provider: { id: 'deepseek', name: 'deepseek' }, retryPolicy: {} }],
    ]),
  };
  const routes = [];
  const webServer = {
    register(options) {
      routes.push(options);
      return () => {};
    },
  };
  const connection = { requestRejection: rejection };
  const ctx = fakeCtx({ llm, webServer, connection });
  ctx.routes = routes;
  apply(ctx, raw);
  return { ctx, models, adapter, llm, routes };
}

/** The common boot: a permissive trust fence. */
function boot(raw) {
  return bootWith(() => undefined, raw);
}

/** Drive the registered route handler once. */
async function request(booted, { method = 'GET', url = `${CHANNEL}/status` } = {}) {
  const route = booted.routes[0];
  const res = fakeRes();
  await route.handler({ method, url, headers: {} }, res);
  return { res, payload: res.body === '' ? undefined : JSON.parse(res.body) };
}

test('publication contract: the package, the patch, and the module', () => {
  assert.equal(pkg.name, 'dsh-opencode-session-header');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.deepEqual(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch is what `dsh plugin add` reads');
  assert.equal(pkg.dsh.client, undefined, 'there is no browser half');
  assert.equal(name, 'opencode-session-header');
  assert.deepEqual(inject, ['llm'], 'only the LLM registry is required; a web server is optional');
  assert.equal(CHANNEL, '/opencode-session-header');

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: opencode-session-header/);
  assert.match(patch, /name: dsh-opencode-session-header/, 'the row must name the package the loader imports');
});

test('no lib file imports anything but node: builtins and siblings', () => {
  const files = readdirSync(join(root, 'lib')).filter((file) => file.endsWith('.js'));
  assert.deepEqual(files.sort(), ['index.js', 'session-header.js']);
  const specifiers = [];
  for (const file of files) {
    const source = readFileSync(join(root, 'lib', file), 'utf8');
    for (const match of source.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      specifiers.push(`${file}: ${match[1]}`);
    }
  }
  assert.equal(specifiers.length >= 1, true, 'the scan found the sibling import, so this test is not vacuous');
  assert.deepEqual(specifiers, ['index.js: ./session-header.js'], 'the host half imports its own core and nothing else');
  for (const entry of specifiers) {
    const specifier = entry.split(': ')[1];
    assert.match(specifier, /^(node:|\.{1,2}\/)/, `${entry} would not resolve from a linked install`);
  }
});

test('resolveAdapterRegistry: reads the route map defensively', () => {
  const registry = new Map();
  assert.equal(resolveAdapterRegistry({ llm: { adapters: registry } }), registry);
  assert.equal(resolveAdapterRegistry({ get: (service) => (service === 'llm' ? { adapters: registry } : undefined) }), registry);
  assert.equal(resolveAdapterRegistry({ reflect: { get: () => ({ adapters: registry }) } }), registry);
  assert.equal(resolveAdapterRegistry({ llm: {} }), undefined, 'a service without a route map is not a registry');
  assert.equal(resolveAdapterRegistry({ llm: { adapters: [] } }), undefined, 'a look-alike that is not a Map is refused');
  assert.equal(resolveAdapterRegistry({}), undefined);
  assert.equal(resolveAdapterRegistry({}), undefined);
  assert.equal(
    resolveAdapterRegistry({ get: () => { throw new Error('shadow context'); } }),
    undefined,
    'an accessor that throws does not take the plugin down',
  );
});

test('apply: hooks the adapter for the scoped routes and logs what it did', (t) => {
  const booted = boot(undefined);
  t.after(() => booted.ctx.effects.forEach((effect) => effect.dispose()));
  assert.equal(Object.prototype.hasOwnProperty.call(booted.adapter, 'streamWithSnapshot'), true, 'the live adapter is wrapped');

  booted.adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models: booted.models });
  assert.equal(booted.models.calls.at(-1).options.headers[HEADER_NAME], UUID);
  booted.adapter.streamWithSnapshot({ provider: 'deepseek', sessionId: SESSION }, { models: booted.models });
  assert.equal(booted.models.calls.at(-1).options.headers, undefined, 'the neighbouring route on the same adapter is untouched');

  const info = booted.ctx.logs.filter((entry) => entry.level === 'info').map((entry) => entry.message);
  assert.equal(info.some((line) => line.includes('hooked 1 pi-ai adapter')), true, `expected a hook line, got ${JSON.stringify(info)}`);
  assert.equal(info.some((line) => line.includes(`${SCOPED_ROUTES.join(' / ')}`)), true, 'the active line names the fixed scope');
  assert.deepEqual(booted.ctx.listeners.map((entry) => entry.event), ['llm/adapters-updated']);
  assert.equal(booted.ctx.listeners[0].options.global, true, 'the registry event must reach this fiber from the LLM plugin');
  assert.equal(booted.routes.length, 1, 'the status endpoint was published');
  assert.equal(booted.routes[0].kind, 'prefix');
  assert.equal(booted.routes[0].path, CHANNEL);
});

test('apply: a later registry change is swept again, and a fresh instance is covered', (t) => {
  const booted = boot(undefined);
  t.after(() => booted.ctx.effects.forEach((effect) => effect.dispose()));
  const hookLines = () => booted.ctx.logs.filter((entry) => /hooked \d+ pi-ai adapter/.test(entry.message)).length;
  assert.equal(hookLines(), 1, 'the boot sweep hooked the first adapter');
  assert.match(booted.ctx.logs.find((entry) => entry.message.includes('hooked')).message, /hooked 1 pi-ai adapter;/, 'one instance, two routes');

  const laterModels = new FakeModels();
  const later = new FakeAdapter(laterModels);
  booted.llm.adapters.set('opencode-go-custom', { adapter: later, provider: { id: 'opencode-go-custom' }, retryPolicy: {} });
  booted.ctx.listeners[0].handler();
  assert.equal(hookLines(), 2, 'the registry event swept again');
  later.streamWithSnapshot({ provider: 'opencode-go-custom', sessionId: SESSION }, { models: laterModels });
  assert.equal(laterModels.calls.at(-1).options.headers[HEADER_NAME], UUID, 'the newly registered route is covered');
  assert.equal(
    Object.prototype.hasOwnProperty.call(later, 'streamWithSnapshot'),
    false,
    'the class hook already covers the instance, so no second wrapper is stacked',
  );
  booted.adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models: booted.models });
  assert.equal(booted.models.calls.at(-1).options.headers[HEADER_NAME], UUID, 'and the first adapter is still covered');
});

test('apply: a late-registering registry is picked up on the event, without a false alarm', async (t) => {
  // A real boot mounts this plugin while the LLM registry is still empty: routes
  // are registered by the LLM plugin's own settings resolution a few seconds
  // later. That path must be silent — the bounded retries sweeps are a backstop,
  // not a failure report — and the status endpoint must show the truth once the
  // event arrives.
  const models = new FakeModels();
  const adapter = new FakeAdapter(models);
  const llm = { adapters: new Map() };
  const routes = [];
  const ctx = fakeCtx({ llm, webServer: { register: (options) => { routes.push(options); return () => {}; } }, connection: { requestRejection: () => undefined } });
  ctx.routes = routes;
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => {
    timers.push(fn);
    return { unref() {} };
  };
  try {
    apply(ctx, undefined);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  t.after(() => ctx.effects.forEach((effect) => effect.dispose()));

  assert.equal(ctx.logs.some((entry) => entry.level === 'error'), false, `an empty registry during boot is normal, got ${JSON.stringify(ctx.logs)}`);
  assert.equal(timers.length, SWEEP_RETRY_MS.length, 'the bounded retry schedule was armed');

  // The retries themselves are silent.
  for (const timer of timers) timer();
  assert.equal(ctx.logs.some((entry) => entry.level === 'error' || entry.level === 'warn'), false, 'a sweep that still finds nothing does not claim failure');

  llm.adapters.set('opencode-go', { adapter, provider: { id: 'opencode-go' }, retryPolicy: {} });
  ctx.listeners[0].handler();
  await adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  const { payload } = await request({ ctx, routes });
  assert.equal(payload.value.hooked.adapters, 1, 'the event sweep hooked the adapter');
  assert.deepEqual(payload.value.diagnostics.filter((entry) => entry.level === 'error'), [], 'and the report carries no error');
  assert.equal(models.calls.at(-1).options.headers[HEADER_NAME], UUID);
});

test('apply: without a web server the header still works', (t) => {
  const models = new FakeModels();
  const adapter = new FakeAdapter(models);
  const ctx = fakeCtx({ llm: { adapters: new Map([['opencode-go', { adapter, provider: { id: 'opencode-go' }, retryPolicy: {} }]]) } });
  apply(ctx, undefined);
  t.after(() => ctx.effects.forEach((effect) => effect.dispose()));
  assert.deepEqual(ctx.routes, [], 'nothing was published');
  adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models });
  assert.equal(models.calls.at(-1).options.headers[HEADER_NAME], UUID, 'the model path is what matters and it is intact');
});
test('apply: an unreachable registry is reported loudly instead of pretending', (t) => {
  const ctx = fakeCtx({ llm: {} });
  apply(ctx, undefined);
  t.after(() => ctx.effects.forEach((effect) => effect.dispose()));
  const errors = ctx.logs.filter((entry) => entry.level === 'error').map((entry) => entry.message);
  assert.equal(errors.some((line) => line.includes('NO session header is being added')), true, `expected a loud diagnostic, got ${JSON.stringify(ctx.logs)}`);
  assert.equal(errors.some((line) => line.includes('did not expose a route map')), true);
});

test('apply: unloading restores the adapter', (t) => {
  const booted = boot(undefined);
  t.after(() => booted.ctx.effects.forEach((effect) => effect.dispose()));
  const labels = booted.ctx.effects.map((effect) => effect.label);
  assert.equal(labels.some((label) => label.includes('adapter hooks')), true, `expected an owned disposer, got ${JSON.stringify(labels)}`);
  assert.equal(labels.some((label) => label.includes(CHANNEL)), true);
  for (const effect of booted.ctx.effects) if (effect.label.includes('adapter hooks')) effect.dispose();
  booted.adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models: booted.models });
  assert.equal(booted.models.calls.at(-1).options.headers, undefined, 'after dispose the adapter is byte-for-byte itself again');
});

test('the status endpoint answers GET with the live report', async (t) => {
  const booted = boot(undefined);
  t.after(() => booted.ctx.effects.forEach((effect) => effect.dispose()));
  booted.adapter.streamWithSnapshot({ provider: 'opencode-go', sessionId: SESSION }, { models: booted.models });

  const { res, payload } = await request(booted);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(payload.ok, true);
  assert.equal(payload.value.name, 'dsh-opencode-session-header');
  assert.equal(payload.value.header, HEADER_NAME);
  assert.deepEqual(payload.value.scope, SCOPED_ROUTES);
  assert.deepEqual(payload.value.hooked.routesInScope, ['opencode-go']);
  assert.equal(payload.value.counters.attached, 1);
  assert.equal(payload.value.counters.last.provider, 'opencode-go');
});

test('the endpoint is fenced, method-checked, and closed to everything else', async (t) => {
  const booted = boot(undefined);
  t.after(() => booted.ctx.effects.forEach((effect) => effect.dispose()));

  // A caller the platform's fence refuses never reaches a handler at all.
  const denied = bootWith(() => 401, undefined);
  t.after(() => denied.ctx.effects.forEach((effect) => effect.dispose()));
  const refusal = fakeRes();
  await denied.routes[0].handler({ method: 'GET', url: `${CHANNEL}/status`, headers: {} }, refusal);
  assert.equal(refusal.statusCode, 401);
  assert.equal(refusal.body, '', 'a rejected caller gets no body at all');

  const posted = await request(booted, { method: 'POST' });
  assert.equal(posted.res.statusCode, 405);
  assert.equal(posted.res.headers.allow, 'GET');

  const unknown = await request(booted, { url: `${CHANNEL}/nope` });
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.payload.ok, false);
  assert.equal(unknown.payload.error.code, 'opencode-session-header/unknown-endpoint');

  const malformed = await request(booted, { url: `${CHANNEL}/status/../secret` });
  assert.equal(malformed.res.statusCode, 404, 'a traversal-shaped path resolves to an unknown endpoint, not a handler');
});
