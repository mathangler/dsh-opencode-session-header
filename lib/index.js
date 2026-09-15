/**
 * dsh-opencode-session-header — host half.
 *
 * A Cordis plugin row (`name: 'dsh-opencode-session-header'`) that puts a
 * stable **per-conversation** `x-opencode-session` header on every inference
 * request an OpenCode Go / Zen route makes, so the gateway stops answering
 * `400 MissingSessionID`. Without it the gateway cannot route the request, and
 * the provider profile's static `headers` map cannot express it: one static
 * value would collapse every conversation onto one routing bucket, which
 * destroys prompt-cache locality.
 *
 * The fix is in-process and reversible. Nothing on disk is patched:
 *
 *   1. `ctx.llm`'s route map is swept for the adapter instances that actually
 *      serve model calls.
 *   2. Each pi-ai shaped adapter — and the class a later instance would come
 *      from — is wrapped at its one dispatch choke point
 *      (`#streamWithSnapshot`), where the snapshot's model collection receives
 *      the final `SimpleStreamOptions`.
 *   3. That collection's `streamSimple` merges the conversation id into the
 *      request's `headers`, the same channel the deployment's static headers
 *      reach, and hands pi-ai a *copy* of the options.
 *
 * Because the hook is applied per object and never to global `fetch`, the
 * process's other traffic, other adapters, and other plugins are untouched; the
 * whole thing is undone by the disposer `ctx.effect` owns. A DSH upgrade needs
 * no re-patching: the next `dsh` boot simply loads this plugin again.
 *
 * A read-only status endpoint answers "is the header actually being added, and
 * would this configuration cover the routes I use?" over one same-origin route.
 * As in the platform's own channels, every request passes
 * `connection.requestRejection(req)` BEFORE a handler runs, so an
 * unauthenticated or cross-origin caller never gets in.
 *
 * @module dsh-opencode-session-header
 */
import { createSessionHeader, HEADER_NAME, SCOPED_ROUTES } from './session-header.js';

/** Cordis plugin name reported to the loader. */
const name = 'opencode-session-header';

/**
 * `llm` is required: without the adapter registry there is nothing to hook and
 * the plugin would be a no-op. `webServer` / `connection` are injected
 * optionally below, so a composition without a web server still gets the
 * header.
 */
const inject = ['llm'];

/** Absolute route prefix owned by this plugin's diagnostic endpoint. */
const CHANNEL = '/opencode-session-header';

/** One endpoint segment: the names `apply` serves, and nothing else. */
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/;

/**
 * Bounded re-sweep schedule, in milliseconds, for the case where an adapter
 * registers after this plugin mounts and the registry event is not delivered to
 * this fiber. A sweep that finds an adapter cancels the rest.
 */
const SWEEP_RETRY_MS = [250, 1000, 3000];

/** Success envelope; the caller unwraps `value`. */
const ok = (value) => ({ ok: true, value });

/** Failure envelope; the caller surfaces `error.message`. */
const fail = (code, message) => ({ ok: false, error: { code, message } });

/** JSON response. `no-store`: the answer is a live fact about this process. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Resolve the LLM runtime's route map from a service context.
 *
 * The map is not part of the LLM service's published surface (its methods
 * enumerate providers as metadata only), so it is read defensively from every
 * accessor Cordis may offer and accepted only when it really is a `Map`. A
 * caller that gets `undefined` must report a diagnostic rather than assume the
 * header is being added.
 *
 * @param ctx - a context with the `llm` service injected.
 * @returns the route map, or `undefined` when it cannot be reached.
 */
export function resolveAdapterRegistry(ctx) {
  const candidates = [];
  const push = (getter) => {
    try {
      candidates.push(getter());
    } catch {
      // An accessor that throws (a shadow context, a disposed service) simply
      // does not contribute a candidate.
    }
  };
  push(() => ctx.llm);
  if (typeof ctx.get === 'function') push(() => ctx.get('llm'));
  if (ctx.reflect !== undefined && typeof ctx.reflect.get === 'function') push(() => ctx.reflect.get('llm'));
  for (const service of candidates) {
    if (service !== null && typeof service === 'object' && service.adapters instanceof Map) return service.adapters;
  }
  return undefined;
}

/**
 * Host plugin body: resolve the policy, hook the adapters, publish the status
 * endpoint.
 *
 * @param ctx - host Cordis context with `llm` injected.
 * @param config - the plugin's configuration, or `undefined` for the defaults.
 */
function apply(ctx, config) {
  /**
   * The conversation id of the call in flight, used only when a request carries
   * none of its own (an auxiliary session-title or compaction call still
   * belongs to a conversation). Registered lazily so a composition without the
   * agent registry boots unchanged; `currentInitiator()` throws once its
   * service is disposed, which is not an error here.
   */
  let initiator;
  ctx.inject(['agents'], (agentCtx) => {
    initiator = () => {
      try {
        const id = agentCtx.agents.currentInitiator()?.session?.id;
        return typeof id === 'string' ? id : undefined;
      } catch {
        return undefined;
      }
    };
  });

  const core = createSessionHeader(config, {
    fallback: () => (initiator === undefined ? undefined : initiator()),
    log: (level, message) => {
      const logger = ctx.logger;
      if (logger === undefined || logger === null) return;
      const line = `opencode-session-header: ${message}`;
      if (level === 'error' && typeof logger.error === 'function') logger.error(line);
      else if (typeof logger.warn === 'function') logger.warn(line);
      else if (typeof logger.info === 'function') logger.info(line);
    },
  });

  const policy = core.config;

  /**
   * Sweep once and report what was found.
   * @returns the number of distinct adapter instances this sweep hooked.
   */
  function sweep() {
    const hooked = core.hookRegistry(resolveAdapterRegistry(ctx));
    if (hooked > 0 && ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
      ctx.logger.info(`opencode-session-header: hooked ${hooked} pi-ai adapter${hooked === 1 ? '' : 's'}; ${HEADER_NAME} is added per conversation on ${SCOPED_ROUTES.join(' / ')} models only`);
    }
    return hooked;
  }

  const hooked = sweep();
  // A route is registered by the LLM plugin's own settings resolution, which
  // routinely finishes *after* this plugin mounts — measured on a real boot, the
  // registry was still empty here and filled in seconds later. The registry
  // event is therefore the primary signal and these bounded sweeps are the
  // backstop. Both stay silent: a sweep that finds nothing during boot is the
  // normal path, not a failure, and the status endpoint reports the current
  // truth. Only an unreachable registry is a real failure, and that is reported
  // by the sweep itself.
  ctx.on('llm/adapters-updated', () => sweep(), { global: true });
  if (hooked === 0) {
    const timers = SWEEP_RETRY_MS.map((delay) => setTimeout(() => sweep(), delay));
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer);
    }, 'dsh-opencode-session-header: sweep retries');
  }

  ctx.effect(() => () => core.dispose(), 'dsh-opencode-session-header: adapter hooks');

  if (!policy.enabled) {
    core.diagnose('warn', 'disabled by configuration; no session header is added');
  } else if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info(`opencode-session-header: active (${HEADER_NAME} on ${SCOPED_ROUTES.join(' / ')}, value mode ${policy.value})`);
  }

  // The diagnostic endpoint is optional: a composition without a web server
  // keeps the header and simply has nowhere to publish the status.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => {
          // The platform's fence, first: an untrusted or unauthenticated caller
          // never reaches a handler.
          const rejection = await webCtx.connection.requestRejection(req);
          if (rejection !== undefined && rejection !== null && rejection !== false && rejection !== 0) {
            res.statusCode = Number(rejection) || 401;
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
            return;
          }
          const pathname = new URL(String(req.url), 'http://localhost').pathname;
          const endpoint = pathname.slice(CHANNEL.length).replace(/^\//, '');
          if (!ENDPOINT_RE.test(endpoint) || endpoint !== 'status') {
            sendJson(res, 404, fail('opencode-session-header/unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`));
            return;
          }
          try {
            sendJson(res, 200, ok(core.status()));
          } catch (error) {
            // A status read must never take the host down.
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 200, fail('opencode-session-header/internal', message));
          }
        },
      }),
      `dsh-opencode-session-header: ${CHANNEL} route`,
    );
  });
}

export { apply, inject, name, CHANNEL, SWEEP_RETRY_MS };
