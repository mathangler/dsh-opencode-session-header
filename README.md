# dsh-opencode-session-header

A DeepSeek Harness plugin that puts a stable **per-conversation**
`x-opencode-session` header on every inference request the **`opencode-go`** and
**`opencode-go-custom`** routes make, so OpenCode's Go / Zen gateway stops
answering `400 MissingSessionID` and can route each conversation to its own
cache bucket.

It replaces the deployment-wide patch script: same fix, same header channel, but

- **no file is patched** — the installed `dsh-llm-pi-ai` bundle stays byte-for-byte
  pristine, and no global `fetch`/undici hook is installed;
- **nothing to re-apply after a DSH upgrade** — the next `dsh` boot loads this
  plugin again;
- **strictly scoped** — the header exists for those two routes and no other, and
  no configuration can widen that;
- **reversible** — unloading the plugin restores every object it touched.

English | [中文](README.zh.md)

## Why a plugin is needed at all

The gateway requires a **per-conversation** id. DSH already knows it and hands it
to pi-ai as `GenerateOptions.sessionId`, but neither layer can turn it into this
header:

| layer | why it cannot |
| --- | --- |
| provider profile (`settings.yaml`) | `headers:` is a *static* map; one value would collapse every conversation onto one routing bucket and destroy prompt-cache locality |
| DSH's `llm/stream` waterfall | `next()` takes no options, and `GenerateOptions` has no `headers` field |
| pi-ai itself | its session-affinity header is gated behind `compat.sendSessionAffinityHeaders`, which no OpenCode route sets — and DSH classifies that switch as `withhold`, so `settings.yaml` cannot enable it |

So the id is present in the request all the way to the adapter and then dropped.
This plugin re-attaches it at the last point where the request's header map is
still an argument.

## Scope: exactly two routes

The scope is a hard-coded whitelist, not a pattern:

```js
export const SCOPED_ROUTES = ['opencode-go', 'opencode-go-custom'];
```

`opencode-zen`, `opencode-go-eu`, `my-opencode-go`, `deepseek` — every other
route is left byte-for-byte alone, including other routes served by the *same*
adapter instance. There is deliberately no `routes:`/`optInRoutes:`/`skipApis:`
key: a configuration surface that can widen this is a surface that can send a
gateway-specific header to a provider that never asked for it. A configuration
attempt is rejected with an error that says so.

This is enforced per **model call**, not per adapter: the plugin hooks the pi-ai
adapter, and the decision reads the route key on the model descriptor pi-ai
received. The test suite asserts the negative case on the same adapter that
carries a whitelisted route.

## How it works

```
GenerateOptions.sessionId
  └─ PiAiAdapter#streamWithSnapshot(options, snapshot)   ← the plugin wraps this
       └─ snapshot.models.streamSimple(model, ctx, { …, headers })   ← and this
            └─ pi-ai merges `headers` into the HTTP client's headers last
```

1. `ctx.llm`'s route map is swept for the adapter instances that serve model
   calls. Every pi-ai shaped adapter is wrapped — at its one dispatch choke point
   and on its class, so a later instance is covered too. The scope decides on the
   call, so hooking broadly cannot add the header narrowly.
2. The wrapped call instruments the snapshot's model collection, which is the
   last object holding the request's `headers` map as an argument.
3. That map gets the conversation id, and pi-ai receives a **copy** of the
   options — the adapter's own request object is never mutated.

Both hooks are published under `Symbol.for` keys, so the objects stay
indistinguishable from untouched ones to anything that enumerates them, and a
second sweep is a no-op instead of a growing wrapper chain. The class hook is what
covers a new instance after an HMR reload; the registry event
(`llm/adapters-updated`) plus two bounded sweeps cover a route that registers
after this plugin mounts.

Nothing is fabricated: a call with no conversation id keeps the deployment's
static headers exactly as they are, unless `sessionlessFallback` lets it borrow
the id of the conversation that initiated it — an auxiliary session-title or
compaction call belongs to a conversation even when it does not say so.

## Value modes

`config.value` decides what the header carries:

| mode | value | when |
| --- | --- | --- |
| `auto` *(default)* | bare UUID, except on `openai-responses` where it is the raw `session-<uuid>` | the Responses implementation already sends `session_id: session-<uuid>` itself, so `auto` makes both headers name the **same** conversation instead of splitting it across two routing buckets |
| `uuid` | bare `05681fd4-…` | the gateway's own documentation; what the patch script sent |
| `id` | raw `session-05681fd4-…` | the gateway accepts this form too |

`auto` matters for this deployment specifically: `opencode-go-custom` is
configured as `api: openai-responses`.

## Install

```bash
dsh plugin --profile web add github:mathangler/dsh-opencode-session-header
```

That runs pnpm in the profile, appends this package to `dsh.profile.bundles`, and
folds in the row from `cordis.patch.yml` — no manual edit. Then **restart the
whole `dsh` process**, not just the session: the bundle is already loaded in
memory, so the plugin only takes effect on a fresh `dsh` / `dsh web`.

- Targets DSH `0.1.6-alpha.1` (and the `0.1.5-rc.*` line). It finds the adapter
  by shape rather than by import, so a bundle that still has
  `PiAiAdapter#streamWithSnapshot` keeps working.
- To update later, remove first — pnpm will not re-resolve a moved `github:`
  HEAD while the spec is unchanged:

  ```bash
  dsh plugin --profile web remove dsh-opencode-session-header
  dsh plugin --profile web add github:mathangler/dsh-opencode-session-header
  ```

- On restricted networks `github.com` itself may be unreachable while installs
  still work: pnpm fetches the tarball from `codeload.github.com`.
- There is no build step and no lifecycle script, so nothing asks for a build
  approval — the source in `lib/` is what runs.

## Configuration

Nothing is required: `opencode-go` / `opencode-go-custom` are covered on install.
To change the policy, override the row by id in the profile's own patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: opencode-session-header
  config:
    value: uuid              # auto | uuid | id
    sessionlessFallback: false
    enabled: true
```

Unknown keys are an error, not a silent no-op — a typo would otherwise look
exactly like a gateway that still refuses the request.

## Verify it is working

The authoritative check is the status endpoint — one authenticated same-origin
GET (it is fenced by the platform's own trust check; an unauthenticated caller
gets `401` with an empty body):

```
GET /opencode-session-header/status
```

Read `value.hooked`, `value.counters` and `value.diagnostics`:

```jsonc
{
  "scope": ["opencode-go", "opencode-go-custom"],
  "header": "x-opencode-session",
  "hooked": { "adapters": 1, "prototypes": 1, "collections": 1,
              "routes": ["deepseek-official", "opencode-go", "opencode-go-custom"],
              "routesInScope": ["opencode-go", "opencode-go-custom"] },
  "counters": { "calls": 12, "scoped": 12, "attached": 12, "sessionless": 0, "outOfScope": 0 },
  "diagnostics": []
}
```

- `hooked.adapters: 0` or a diagnostic — the registry was not reachable, and the
  header is **not** being added. That is reported loudly at boot, never silently.
- `hooked.routesInScope: []` — no route in this profile names the gateway.
- `counters.attached: 0` with `calls: 0` — no model call has happened yet; no
  credential is needed to see the hook, but the counters only move on real
  traffic.
- `preview` shows the exact decision for each scoped route × protocol pair, which
  is the quickest way to confirm a `value` mode change.

The plugin also reports through the host logger (`ctx.logger.info` for a
successful hook, `ctx.logger.error` when the LLM registry cannot be reached).
Note that a real `dsh web` boot does **not** surface `ctx.logger.info` on stdout —
checked on this machine — so use the endpoint rather than the terminal as your
answer.

## Evidence

Three suites, 40 checks, all green against this machine's
`dsh 0.1.6-alpha.1` / pi-ai `0.85.1`:

```bash
node test/session-header.test.mjs   # 19
node test/adapter.test.mjs          # 10
node test/host.test.mjs             # 11
```

(`node --test test/` works too where the environment allows spawning child
processes; each file also runs directly, in-process.)

| suite | what it proves |
| --- | --- |
| `test/session-header.test.mjs` (19) | the policy: scope, value modes, never fabricate, no mutation of the adapter's object, hook idempotence and exact restore, counters on every branch |
| `test/adapter.test.mjs` (10) | the **real installed** `PiAiAdapter` driven with pi-ai's own `fauxProvider`: the header reaches the exact `SimpleStreamOptions.headers` map that pi-ai's `createClient` merges last, on the direct `stream()` path and on the prepared-call path the agent loop uses — with a control run that proves the environment alone adds nothing |
| `test/host.test.mjs` (11) | the publication contract, the defensive registry lookup, the plugin wiring (including a composition with no web server), the late-registering registry path, and the endpoint's fence/method/path handling |

Booting a real `dsh web` with this plugin loaded (throwaway `DSH_HOME`, junctions
instead of pnpm) confirmed the part no unit test can: `ctx.llm.adapters` is
reachable in a live process, the hook lands on the live adapter
(`hooked.adapters: 1`, `routesInScope: ["opencode-go", "opencode-go-custom"]`),
the endpoint answers `200` with the profile's cookie and `401` without it, and
`diagnostics` is empty.

## What it deliberately does not do

- It does not patch the install, any bundle on disk, or global `fetch`.
- It does not touch, wrap, or inspect any adapter that is not pi-ai shaped, and it
  never adds a header to a route outside the whitelist.
- It cannot label a call that carries no conversation id *and* has no initiating
  agent in scope; such a call is left exactly as the deployment configured it.

## Files

- `lib/session-header.js` — the transport-free core: policy, the per-call
  transform, the hooks, the status report.
- `lib/index.js` — the Cordis host half: registry sweep, logging, the read-only
  status endpoint.
- `test/` — the three suites above.
- `cordis.patch.yml` — the profile bundle patch (one row).

Both `lib/` files import only `node:` builtins and each other. That is not a
style choice: a plugin installed with `dsh plugin add file:<dir>` is *linked* into
the profile and resolves modules from its own directory, so a bare
`import '@deepseek-ai/…'` would break at exactly the load it is needed for — and
a test asserts the invariant rather than trusting it.

## License

MIT. See [LICENSE](LICENSE).
