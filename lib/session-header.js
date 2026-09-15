/**
 * dsh-opencode-session-header — transport-free core.
 *
 * OpenCode's Go / Zen gateway answers
 * `400 MissingSessionID` unless every inference request carries a stable
 * **per-conversation** session id. DSH already knows that id
 * (`GenerateOptions.sessionId`) and hands it to pi-ai, but the pi-ai adapter's
 * only header source is the provider profile's *static* `headers` map, and
 * pi-ai itself gates its own session-affinity header behind a compat switch no
 * OpenCode route sets. So no amount of configuration can put a
 * per-conversation value on the wire.
 *
 * This module owns the in-process fix. `PiAiAdapter#streamWithSnapshot` is the
 * single choke point every model call funnels through, and the
 * `snapshot.models` collection it dispatches to receives the exact
 * `SimpleStreamOptions` — including the final `headers` map — that pi-ai is
 * about to use. Wrapping those two objects merges the conversation id into
 * that map, which is the same header channel the deployment's static `headers`
 * already reach: nothing else about the request changes, and the adapter's own
 * source file is never touched.
 *
 * **The scope is one hard-coded whitelist.** The header exists for the OpenCode
 * Go / Zen routes — `opencode-go` and `opencode-go-custom` — and is added for no
 * other route under any configuration. There is deliberately no route
 * pattern, no opt-in list, and no exclusion list: a configuration surface that
 * can widen this would be a surface that can send a gateway-specific header to
 * a provider that never asked for it. A route outside the whitelist is left
 * byte-for-byte alone, and the status report proves it by previewing the
 * decision per protocol.
 *
 * Two more rules keep the wrapper honest:
 *
 *   1. **A header is never fabricated.** A call without a conversation id
 *      either keeps the deployment's static value or, when
 *      `sessionlessFallback` is on, borrows the id of the conversation that
 *      initiated it — never a constant, which would collapse every
 *      conversation onto one routing bucket.
 *   2. **The request object is never mutated.** pi-ai receives a copy of the
 *      options, so an adapter or consumer holding a reference observes nothing.
 *
 * Nothing here imports `@deepseek-ai/*`. A plugin installed with
 * `dsh plugin add file:<dir>` is *linked* into the profile, so it resolves
 * modules from its own directory rather than the profile's; the adapter is
 * therefore reached structurally, by shape, never by class identity, and the
 * only imports in this package are `node:` builtins and sibling files.
 *
 * @module dsh-opencode-session-header/session-header
 */

/**
 * The only routes whose models ever receive the header, matched
 * case-insensitively and exactly. `opencode-go` is pi-ai's builtin provider key
 * for the gateway; `opencode-go-custom` is the profile route this deployment
 * configured on top of it. Both name the same contract, so both are in scope —
 * and nothing else is.
 */
export const SCOPED_ROUTES = ['opencode-go', 'opencode-go-custom'];

/** The field name the gateway accepts. */
export const HEADER_NAME = 'x-opencode-session';

/**
 * Wire protocols that already send a session header pi-ai recognises, so the
 * `auto` value mode must follow pi-ai's own value instead of inventing a second
 * one. Only the plain `openai-responses` implementation qualifies: it sets
 * `session_id` (plus `x-client-request-id`) from `options.sessionId`
 * unconditionally. `azure-openai-responses` sets none,
 * `openai-codex-responses` sets a pair the gateway does not accept, and
 * `anthropic-messages` / `openai-completions` gate theirs behind a compat
 * switch that OpenCode routes leave off.
 *
 * This matters for this deployment specifically: `opencode-go-custom` is
 * configured as `openai-responses`, so a bare-UUID value there would disagree
 * with pi-ai's own `session_id: session-<uuid>` for the same conversation and
 * split its routing bucket in two.
 */
const NATIVE_SESSION_APIS = new Set(['openai-responses']);

/** Accepted `value` modes. */
const VALUE_MODES = new Set(['auto', 'uuid', 'id']);

/** Every configuration key this plugin understands. */
const CONFIG_KEYS = new Set(['enabled', 'value', 'sessionlessFallback']);

/** `session-` is the DSH session id's own prefix, not part of the gateway value. */
const SESSION_PREFIX_RE = /^session-/;

/** How many recent diagnostics the status report keeps. */
const DIAGNOSTIC_LIMIT = 20;

/** A configuration or instrumentation failure, carrying a stable code. */
export class SessionHeaderError extends Error {
  /**
   * @param code - stable machine-readable code.
   * @param message - human-readable description.
   */
  constructor(code, message) {
    super(message);
    this.name = 'SessionHeaderError';
    this.code = code;
  }
}

/**
 * The shipped defaults. The scope is not among them: it is a constant.
 * @returns a fresh default configuration object.
 */
export function defaultConfig() {
  return {
    enabled: true,
    value: 'auto',
    sessionlessFallback: true,
  };
}

/** Assert one config value is a boolean. */
function requireBoolean(key, value) {
  if (typeof value !== 'boolean') {
    throw new SessionHeaderError('opencode-session-header/invalid-config', `config.${key} must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate a raw configuration object against the shipped defaults.
 *
 * An unknown key is an error rather than a silent no-op — a typo would
 * otherwise look exactly like a gateway that still refuses the request. The
 * message names the fixed scope, because `routes:` and its relatives are the
 * keys a reader is most likely to try.
 *
 * @param raw - the plugin configuration, or `undefined` for all defaults.
 * @returns a complete, validated configuration.
 * @throws {SessionHeaderError} when a key is unknown or mistyped.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new SessionHeaderError('opencode-session-header/invalid-config', `config must be an object, got ${JSON.stringify(raw)}`);
  }
  const config = defaultConfig();
  if (raw === undefined || raw === null) return config;
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new SessionHeaderError(
        'opencode-session-header/invalid-config',
        `unknown config key ${JSON.stringify(key)}; the configurable keys are ${[...CONFIG_KEYS].join(', ')}. `
        + `The route scope is fixed: only ${SCOPED_ROUTES.join(' and ')} models receive ${HEADER_NAME}.`,
      );
    }
  }
  if (raw.enabled !== undefined) config.enabled = requireBoolean('enabled', raw.enabled);
  if (raw.sessionlessFallback !== undefined) {
    config.sessionlessFallback = requireBoolean('sessionlessFallback', raw.sessionlessFallback);
  }
  if (raw.value !== undefined) {
    if (typeof raw.value !== 'string' || !VALUE_MODES.has(raw.value)) {
      throw new SessionHeaderError('opencode-session-header/invalid-config', `config.value must be one of ${[...VALUE_MODES].join(', ')}, got ${JSON.stringify(raw.value)}`);
    }
    config.value = raw.value;
  }
  return config;
}

/**
 * Whether one model's route is inside the fixed scope.
 *
 * Exact, case-insensitive membership: a route that merely resembles the
 * gateway's — `opencode-zen`, `my-opencode-go`, `opencode-go-eu` — is outside
 * it, and stays untouched.
 *
 * @param provider - the route key on the model descriptor pi-ai received.
 * @returns whether this route may receive the header.
 */
export function isScopedRoute(provider) {
  if (typeof provider !== 'string') return false;
  const route = provider.toLowerCase();
  return SCOPED_ROUTES.some((scoped) => scoped === route);
}

/**
 * The header name one model's call should carry, or `undefined` when the call
 * is out of scope.
 *
 * Scope is decided from the model descriptor pi-ai received, which carries
 * `provider` (the route key). A call with no conversation id is still in scope
 * here — {@link applySessionHeader} is what decides whether it can be labelled.
 *
 * @param model - the pi-ai model descriptor, or anything shaped like one.
 * @param config - a resolved configuration.
 * @returns the header name to attach, or `undefined`.
 */
export function headerNameFor(model, config) {
  if (!config.enabled) return undefined;
  return isScopedRoute(model?.provider) ? HEADER_NAME : undefined;
}

/**
 * The value one session id contributes to the header.
 *
 * `uuid` sends the bare UUID the gateway's own documentation asks for and is
 * what the deployment-wide operation sent. `id` sends the DSH session id
 * verbatim (`session-<uuid>`), which the gateway also accepts. `auto` picks per
 * protocol: a protocol that already sends pi-ai's own session header gets the
 * raw id, so both headers name the same conversation instead of splitting it
 * across two routing buckets; every other protocol gets the bare UUID.
 *
 * @param sessionId - the conversation id, with or without the `session-` prefix.
 * @param api - the wire protocol of the call.
 * @param mode - one of `auto`, `uuid`, `id`.
 * @returns the header value.
 */
export function sessionHeaderValue(sessionId, api, mode) {
  const raw = String(sessionId);
  if (mode === 'id') return raw;
  const bare = raw.replace(SESSION_PREFIX_RE, '');
  if (mode === 'uuid') return bare;
  return NATIVE_SESSION_APIS.has(typeof api === 'string' ? api : '') ? raw : bare;
}

/** Shorten a value for a status report, which is read by a human. */
function mask(value) {
  const text = String(value);
  return text.length <= 14 ? text : `${text.slice(0, 14)}…`;
}

/** Case-insensitive delete of a field name from a header map, without mutating it. */
function withoutField(headers, name) {
  const target = name.toLowerCase();
  const kept = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Merge the conversation's header into one call's options.
 *
 * The returned options object is always a copy: the adapter's own request
 * object is never mutated, so a caller that keeps a reference cannot observe
 * this plugin's work. A same-named static entry is replaced rather than
 * duplicated, and the case-insensitive removal matches how the adapter itself
 * reconciles the deployment's header map with the Harness attribution names.
 *
 * @param model - the pi-ai model descriptor of the call.
 * @param options - the `SimpleStreamOptions` the adapter built.
 * @param config - a resolved configuration.
 * @param stats - the counter object to record into.
 * @param fallback - `() => sessionId | undefined` for a sessionless call, or `undefined`.
 * @returns the options pi-ai should use.
 */
export function applySessionHeader(model, options, config, stats, fallback) {
  stats.calls += 1;
  const name = headerNameFor(model, config);
  if (name === undefined) {
    stats.outOfScope += 1;
    return options;
  }
  stats.scoped += 1;
  let sessionId = options?.sessionId;
  let source = 'request';
  if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
    const inherited = config.sessionlessFallback && typeof fallback === 'function' ? fallback() : undefined;
    if (inherited === undefined || inherited === null || String(inherited) === '') {
      // No conversation to name: the deployment's static headers stay exactly
      // as they are, which is what an anonymous or auxiliary call needs.
      stats.sessionless += 1;
      return options;
    }
    sessionId = inherited;
    source = 'initiator';
    stats.inherited += 1;
  }
  const value = sessionHeaderValue(sessionId, model?.api, config.value);
  const base = options !== null && typeof options === 'object' ? options : {};
  const headers = { ...withoutField(base.headers ?? {}, name), [name]: value };
  stats.attached += 1;
  stats.last = {
    at: new Date().toISOString(),
    provider: typeof model?.provider === 'string' ? model.provider : undefined,
    api: typeof model?.api === 'string' ? model.api : undefined,
    header: name,
    value: mask(value),
    source,
  };
  return { ...base, headers };
}

/** A fresh counter object. Plain numbers, so a status report is JSON-safe. */
function createStats() {
  return {
    calls: 0,
    scoped: 0,
    attached: 0,
    sessionless: 0,
    outOfScope: 0,
    inherited: 0,
    last: undefined,
  };
}

const MODELS_HOOK = Symbol.for('dsh-opencode-session-header/models');
const ADAPTER_HOOK = Symbol.for('dsh-opencode-session-header/adapter');

/**
 * Wrap one pi-ai model collection's `streamSimple`, which is the last point
 * where the request's header map is still an argument.
 *
 * The record is published under a `Symbol.for` key rather than a string
 * property, so the collection stays indistinguishable from an untouched one to
 * anything that enumerates it; the same symbol is what makes a second wrap a
 * no-op instead of a growing chain.
 *
 * @param models - the collection the adapter dispatches through.
 * @param decide - `(model, options) => options` per call.
 * @returns the hook record, or `undefined` when the object cannot carry the hook.
 */
export function instrumentModels(models, decide) {
  if (models === null || typeof models !== 'object' || typeof models.streamSimple !== 'function') return undefined;
  const existing = models[MODELS_HOOK];
  if (existing !== undefined) return existing;
  const hadOwn = Object.prototype.hasOwnProperty.call(models, 'streamSimple');
  const previous = models.streamSimple;
  const record = {
    previous,
    hadOwn,
    decide,
    wrapped(model, context, options) {
      return previous.call(this, model, context, decide(model, options));
    },
    restore() {
      if (models[MODELS_HOOK] !== record) return;
      if (hadOwn) models.streamSimple = previous;
      else delete models.streamSimple;
      delete models[MODELS_HOOK];
    },
  };
  Object.defineProperty(models, MODELS_HOOK, { value: record, configurable: true, writable: true });
  models.streamSimple = record.wrapped;
  return record;
}

/**
 * Wrap one adapter instance's `streamWithSnapshot`.
 *
 * Every entry point the LLM runtime uses — `stream()` and the `stream` handle
 * `prepareCall()` returns — resolves the adapter's current snapshot and then
 * calls this method with it, so hooking here reaches every model call without
 * re-reading any adapter internals. The wrapped call instruments the snapshot's
 * model collection first, which is idempotent per snapshot.
 *
 * The hook transforms a call only when the model's route is in scope, so
 * `deepseek`'s own adapter — which also derives from the same base class — is
 * never affected even if it were hooked.
 *
 * A record owns everything it touched: restoring it also retires the model
 * collections it instrumented, and only those whose hook it installed. A
 * collection instrumented by someone else's hook is left to its owner.
 *
 * The "already hooked" test looks the symbol up the prototype chain on purpose:
 * an instance whose class already carries the hook is *covered* by it — calls
 * reach the class wrapper — so no second wrapper is added, and sweeping the same
 * class again is free rather than a growing chain.
 *
 * @param adapter - the adapter instance or prototype the LLM registry holds.
 * @param decide - `(model, options) => options` per call.
 * @param onCollection - notified with each collection this record instruments.
 * @returns the hook record covering this object, or `undefined` when it is not
 *   pi-ai shaped.
 */
export function instrumentAdapter(adapter, decide, onCollection) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.streamWithSnapshot !== 'function') return undefined;
  // Chain lookup, not an own-property test: a class hook covers its instances.
  const existing = adapter[ADAPTER_HOOK];
  if (existing !== undefined) return existing;
  const hadOwn = Object.prototype.hasOwnProperty.call(adapter, 'streamWithSnapshot');
  const previous = adapter.streamWithSnapshot;
  const touched = new Set();
  const record = {
    previous,
    hadOwn,
    wrapped(options, snapshot) {
      if (snapshot !== null && typeof snapshot === 'object' && snapshot.models !== undefined) {
        const models = snapshot.models;
        const modelsRecord = instrumentModels(models, decide);
        if (modelsRecord !== undefined && modelsRecord.decide === decide) {
          touched.add(models);
          if (typeof onCollection === 'function') onCollection(models);
        }
      }
      return previous.call(this, options, snapshot);
    },
    restore() {
      if (adapter[ADAPTER_HOOK] !== record) return;
      if (hadOwn) adapter.streamWithSnapshot = previous;
      else delete adapter.streamWithSnapshot;
      delete adapter[ADAPTER_HOOK];
      for (const models of touched) {
        if (models[MODELS_HOOK]?.decide === decide) models[MODELS_HOOK].restore();
      }
      touched.clear();
    },
  };
  Object.defineProperty(adapter, ADAPTER_HOOK, { value: record, configurable: true, writable: true });
  adapter.streamWithSnapshot = record.wrapped;
  return record;
}

/**
 * Build the plugin's core.
 *
 * @param raw - the raw plugin configuration.
 * @param internals - injection seams: `fallback` for the sessionless case and
 *   `log` for a sink for diagnostics.
 * @returns the core: the per-call transform, the adapter sweep, the status
 *   report, and one disposer that restores every object it touched.
 */
export function createSessionHeader(raw, internals = {}) {
  const config = resolveConfig(raw);
  const stats = createStats();
  const buffer = [];
  const adapters = new Set();
  const prototypes = new Map();
  const collections = new Set();
  /** Every route key the registry held when it was last swept. */
  const routesSeen = new Set();
  const log = typeof internals.log === 'function' ? internals.log : () => {};

  /** Record one diagnostic for the status report and the log sink. */
  function diagnose(level, message) {
    const entry = { at: new Date().toISOString(), level, message };
    buffer.push(entry);
    while (buffer.length > DIAGNOSTIC_LIMIT) buffer.shift();
    try {
      log(level, message);
    } catch {
      // A logging sink must never break the model path.
    }
  }

  const decide = (model, options) => applySessionHeader(model, options, config, stats, internals.fallback);

  /**
   * Sweep the LLM registry's route map.
   *
   * The map is keyed by route and holds `{ adapter, provider, retryPolicy }`
   * entries. Every pi-ai shaped adapter is hooked, whatever routes it serves,
   * because the scope is enforced per model call rather than per adapter: a
   * deployment that reaches `opencode-go` through a differently named route is
   * still covered, while a `deepseek` route on the same class is untouched.
   * Anything that is not pi-ai shaped is left alone.
   *
   * @param registry - the value of the LLM runtime's route map.
   * @returns the number of distinct adapter instances this sweep hooked.
   */
  function hookRegistry(registry) {
    if (registry instanceof Map) {
      for (const route of registry.keys()) routesSeen.add(String(route));
    } else {
      diagnose('error', 'the LLM registry did not expose a route map, so no adapter could be hooked and NO session header is being added');
      return 0;
    }
    const instances = new Set();
    for (const registration of registry.values()) {
      const adapter = registration?.adapter;
      if (adapter === null || adapter === undefined || typeof adapter !== 'object') continue;
      if (typeof adapter.streamWithSnapshot !== 'function') continue;
      const record = instrumentAdapter(adapter, decide, (models) => collections.add(models));
      if (record === undefined) continue;
      adapters.add(adapter);
      instances.add(adapter);
      const prototype = Object.getPrototypeOf(adapter);
      if (prototype !== null && prototype !== undefined && prototype !== Object.prototype && !prototypes.has(prototype)) {
        // A later instance (an HMR reload builds a new adapter) must be covered
        // too, so the class is instrumented as well as the live instance.
        const prototypeRecord = instrumentAdapter(prototype, decide, (models) => collections.add(models));
        if (prototypeRecord !== undefined) prototypes.set(prototype, prototypeRecord);
      }
    }
    const swept = instances.size;
    if (swept > 0 && ![...routesSeen].some((route) => isScopedRoute(route))) {
      diagnose('warn', `no route in the LLM registry names ${SCOPED_ROUTES.join(' or ')}; the registry holds ${[...routesSeen].join(', ') || 'no routes'}, so the header stays off until such a route is registered`);
    }
    return swept;
  }

  return {
    config,
    stats,
    decide,
    hookRegistry,
    diagnose,
    /**
     * The JSON-safe status report behind the diagnostic endpoint. It answers
     * the two questions an operator has: is the header actually being added,
     * and is this configuration covering the routes I use?
     * @returns the status report.
     */
    status() {
      const preview = [];
      for (const route of SCOPED_ROUTES) {
        for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses']) {
          const header = headerNameFor({ provider: route, api }, config);
          preview.push({
            route,
            api,
            header: header ?? null,
            // A placeholder id, so the preview reads as the shape of the value
            // rather than one particular conversation.
            value: header === undefined ? null : sessionHeaderValue('session-<uuid>', api, config.value),
          });
        }
      }
      return {
        name: 'dsh-opencode-session-header',
        scope: [...SCOPED_ROUTES],
        header: HEADER_NAME,
        config: { ...config },
        hooked: {
          adapters: adapters.size,
          prototypes: prototypes.size,
          collections: collections.size,
          routes: [...routesSeen].sort(),
          routesInScope: [...routesSeen].filter((route) => isScopedRoute(route)).sort(),
        },
        counters: { ...stats },
        preview,
        diagnostics: [...buffer],
      };
    },
    /** Restore every object this core touched, in reverse order of hooking. */
    dispose() {
      for (const record of prototypes.values()) record.restore();
      prototypes.clear();
      // Each adapter record owns the model collections it instrumented, so
      // restoring the records is what retires those hooks; the `collections`
      // set is the status report's count, not a second cleanup path.
      for (const adapter of adapters) {
        const record = adapter[ADAPTER_HOOK];
        if (record !== undefined) record.restore();
      }
      adapters.clear();
    },
  };
}
