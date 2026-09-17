# dsh-opencode-session-header

一个 DeepSeek Harness 插件：给**以 `opencode-go` 开头的 route**（内置的 `opencode-go`、
本部署的 `opencode-go-custom`，以及以后新增的同族 route）的每次推理请求带上稳定的
**每会话** `x-opencode-session` 头，让 OpenCode 的 Go / Zen 网关不再返回
`400 MissingSessionID`，并把每个会话路由到各自的缓存桶。

它是原来那份"打补丁脚本"的替代方案：解决的问题一样、用的请求头通道一样，但

- **不改任何文件** —— 已安装的 `dsh-llm-pi-ai` bundle 保持原样，也没有 patch 全局
  `fetch` / undici；
- **DSH 升级后不用重打** —— 下次启动 `dsh` 自然就加载这个插件；
- **范围严格** —— 只对某一个前缀之下的 route 生效，任何配置都无法扩大范围；
- **可逆** —— 卸载插件会把它碰过的每个对象还原。

[English](README.md) | 中文

## 为什么必须做成插件

网关要的是**每会话**的 id。DSH 本来就知道这个 id（`GenerateOptions.sessionId`，一直
传到 pi-ai），但上下游都没有办法把它变成这个头：

| 层 | 为什么不行 |
| --- | --- |
| provider profile（`settings.yaml`） | `headers:` 是**静态** map；一个固定值会把所有会话压进同一个路由桶，破坏 prompt cache 的局部性 |
| DSH 的 `llm/stream` waterfall | `next()` 不接受改过的 options，而 `GenerateOptions` 根本没有 `headers` 字段 |
| pi-ai 自身 | 它的 session 头被 `compat.sendSessionAffinityHeaders` 开关挡住，OpenCode 的 route 都没开这个开关；而 DSH 把这个字段归为 `withhold`，`settings.yaml` 也写不进去 |

也就是说，这个 id 一路活到了适配器，然后被丢掉。本插件在**请求头 map 还是参数的最后一个
位置**把它重新挂上去。

## 范围：所有 `opencode-go…` route

范围是**一个固定的前缀** —— 不是名单，也不是可配置的模式：

```js
export const SCOPED_ROUTE_PREFIX = 'opencode-go';   // 大小写不敏感
export const SCOPED_ROUTE_PATTERN = 'opencode-go*'; // 状态报告里显示的形式
```

所以内置的 `opencode-go`、本部署的 `opencode-go-custom`、以后可能出现的
`opencode-go-eu`，以及任何 route key 以 `opencode-go` 开头的 route，**一注册就自动被覆盖**
—— 不需要改配置，也不需要发新版本。其他 route 一个字节都不动，**包括由同一个适配器实例
承载的其他 route**：`opencode-zen`（另一个网关契约）、`my-opencode-go`（前缀锚定在开头）、
`opencode`、`deepseek`。

这里刻意没有 `routes:` / `optInRoutes:` / `skipApis:` 这类配置：范围是代码里的常量，
所以不可能因为配置写错而把某个网关专用的头发给根本没要求它的 provider。写了这些键会直接
报错，并明确说明界线划在哪里。

范围是按**每次模型调用**判定的，不是按适配器：插件挂的是 pi-ai 适配器，判定依据是
pi-ai 收到的 model descriptor 上的 route key。测试在**同一个适配器实例**上把两个方向都断言
了：`opencode-go-eu` 会被加头，`opencode-zen` 什么都不加。

## 工作原理

```
GenerateOptions.sessionId
  └─ PiAiAdapter#streamWithSnapshot(options, snapshot)   ← 插件包住这里
       └─ snapshot.models.streamSimple(model, ctx, { …, headers })   ← 还有这里
            └─ pi-ai 最后把 `headers` 合并进 HTTP client 的请求头
```

1. 扫描 `ctx.llm` 的 route map，找出真正承载模型调用的适配器实例。凡是 pi-ai 形状的
   适配器都会在它唯一的派发收口处被包一层，并且它的**类**也会被包（这样 HMR 之后新建
   的实例同样被覆盖）。因为范围是逐次调用判定的，"包得宽"不会导致"加得宽"。
2. 被包的调用会先给该 snapshot 的 models 集合安装钩子——那是最后一个"请求头 map 还是
   参数"的对象。
3. 把会话 id 合进这个 map，并给 pi-ai 一份 options 的**副本**：适配器自己的请求对象
   永远不会被改。

两个钩子都用 `Symbol.for` 键记录，所以这些对象在枚举时和被改过之前毫无区别；第二次扫描
是 no-op，不会堆成一串 wrapper。类级钩子负责覆盖 HMR 后新建的实例；注册表事件
（`llm/adapters-updated`）加两次有界重扫，负责覆盖"本插件挂载之后才注册的 route"。

不会伪造任何值：没有会话 id 的调用会原样保留部署里配置的静态头；只有
`sessionlessFallback` 打开时，才会借用发起这次调用的那个会话的 id——辅助性的
session-title / compaction 调用虽然自己不带 id，但它确实属于某个会话。

## 值的模式

`config.value` 决定头里放什么：

| 模式 | 值 | 说明 |
| --- | --- | --- |
| `auto`（默认） | 裸 UUID；但在 `openai-responses` 上是原始 `session-<uuid>` | Responses 实现自己就发 `session_id: session-<uuid>`，`auto` 让两个头指向**同一个**会话，而不是把一个会话劈成两个路由桶 |
| `uuid` | 裸 `05681fd4-…` | 网关文档里的写法，也是原补丁脚本发的形式 |
| `id` | 原始 `session-05681fd4-…` | 网关同样接受 |

`auto` 对本部署尤其重要：`opencode-go-custom` 配的是 `api: openai-responses`。

## 安装

```powershell
dsh plugin --profile web add github:mathangler/dsh-opencode-session-header
```

它会在这个 profile 里跑 pnpm、把本包追加进 `dsh.profile.bundles`，并自动折入
`cordis.patch.yml` 里的那一行（不需要手工改任何文件）。之后必须**完整重启 dsh 进程**
（不是只重开会话）：bundle 已经加载在内存里，只有全新的 `dsh` / `dsh web` 才会带上插件。

- 目标版本：DSH `0.1.6-alpha.1`（以及 `0.1.5-rc.*` 线）。它按**形状**而不是 import 找到适配器，
  所以只要 bundle 里还有 `PiAiAdapter#streamWithSnapshot` 就继续可用。
- 以后升级要先 remove 再 add —— 当依赖规格没变时，pnpm 不会重新解析移动过的 `github:` HEAD：

  ```powershell
  dsh plugin --profile web remove dsh-opencode-session-header
  dsh plugin --profile web add github:mathangler/dsh-opencode-session-header
  ```

- 受限网络下 `github.com` 本身可能连不上，但安装通常仍然可用：pnpm 是从
  `codeload.github.com` 取 tarball 的。
- 本包没有构建步骤、没有生命周期脚本，因此不会触发任何 build 审批 —— `lib/` 里的源码就是
  实际运行的代码。

## 配置

默认什么都不用配：所有 `opencode-go…` route 装上即覆盖。要改策略，在 profile
自己的补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）里按 id 覆盖：

```yaml
- id: opencode-session-header
  config:
    value: uuid              # auto | uuid | id
    sessionlessFallback: false
    enabled: true
```

未知的键会报错，而不是静默失效——否则一个拼写错误看起来会和"网关仍然拒绝请求"一模一样。

## 怎么确认它在工作

**权威的检查方式是状态端点** —— 一条带鉴权的同源 GET（它走平台自己的信任围栏；未鉴权
的调用者拿到 `401` 且响应体为空）：

```
GET /opencode-session-header/status
```

重点看 `value.hooked`、`value.counters`、`value.diagnostics`：

```jsonc
{
  "scope": ["opencode-go*"],
  "header": "x-opencode-session",
  "hooked": { "adapters": 1, "prototypes": 1, "collections": 1,
              "routes": ["deepseek-official", "opencode-go", "opencode-go-custom"],
              "routesInScope": ["opencode-go", "opencode-go-custom"] },
  "counters": { "calls": 12, "scoped": 12, "attached": 12, "sessionless": 0, "outOfScope": 0 },
  "diagnostics": []
}
```

- `hooked.adapters: 0` 或出现 diagnostic —— 拿不到注册表，**头没有加上**。这种情况启动
  时就会大声报出来，绝不会静默。
- `hooked.routesInScope: []` —— 这个 profile 里没有任何 route 以该前缀开头。
- `calls: 0` 且 `attached: 0` —— 还没有发生过模型调用。看钩子不需要凭证，但计数器只有
  真实流量才会动。
- `preview` 会拿前缀内两条 route（`opencode-go`、`opencode-go-custom`）和前缀外两条
  （`opencode-zen`、`deepseek`）分别对三种协议求值，所以它同时展示"判定结果"和"界线在哪"
  —— 是确认改 `value` 是否生效最快的方式。

插件同时会往 host logger 里写行（成功挂上钩子时用 `ctx.logger.info`，拿不到 LLM 注册表时
用 `ctx.logger.error`）。但请注意：在本机实测中，真实的 `dsh web` 启动**不会**把
`ctx.logger.info` 打到 stdout —— 所以请以端点结果为准，而不是终端输出。

## 证据

三个测试套件、40 项断言，在本机的 `dsh 0.1.6-alpha.1` / pi-ai `0.85.1` 上全绿：

```powershell
node test/session-header.test.mjs   # 19
node test/adapter.test.mjs          # 10
node test/host.test.mjs             # 11
```

（环境允许 spawn 子进程时也可以用 `node --test test/`；每个文件本身也能直接以进程内方式
运行。）

| 套件 | 证明什么 |
| --- | --- |
| `test/session-header.test.mjs`（19） | 策略本身：范围、值的模式、绝不伪造、绝不改适配器对象、钩子的幂等与精确还原、每个分支都被计数器证明跑到过 |
| `test/adapter.test.mjs`（10） | 用 pi-ai 自带的 `fauxProvider` 驱动**本机真实安装的** `PiAiAdapter`：头确实进到了 pi-ai `createClient` 最后合并的那个 `SimpleStreamOptions.headers`，且**直接 `stream()` 路径**与"agent loop 实际走的 prepared-call 路径"都覆盖；另有对照运行证明"光是环境本身什么都不加"，以及一条五 route 的用例钉住前缀边界（`opencode-go-eu` 加头；`opencode-zen`、`my-opencode-go`、`deepseek` 不加） |
| `test/host.test.mjs`（11） | 发布契约、防御式注册表查找、插件装配（含"没有 web server 的组合"）、route 晚注册的路径、以及端点的信任围栏/方法/路径处理 |

另外用真实进程验证了单元测试覆盖不到的那一环：用一次性 `DSH_HOME`（用 junction 代替
pnpm）启动真实 `dsh web` 并加载本插件，确认 `ctx.llm.adapters` 在活进程里可达、钩子确实
落在活的适配器上（`hooked.adapters: 1`、
`routesInScope: ["opencode-go", "opencode-go-custom"]`）、带 profile cookie 请求端点返回
`200`、不带返回 `401`，且 `diagnostics` 为空。

## 刻意不做的事

- 不改安装目录、不改磁盘上的任何 bundle、不 patch 全局 `fetch`。
- 不碰、不包、不读任何非 pi-ai 形状的适配器；也绝不给前缀之外的 route 加头。
- 对于"既没有会话 id、范围内又找不到发起它的 agent"的调用，不做标注——原样保留部署配置
  的头。

## 文件

- `lib/session-header.js` —— 与传输无关的核心：策略、每次调用的变换、钩子、状态报告。
- `lib/index.js` —— Cordis host 半边：注册表扫描、日志、只读状态端点。
- `test/` —— 上面三个套件。
- `cordis.patch.yml` —— profile bundle 补丁（一行）。

`lib/` 里两个文件只 import `node:` 内置模块和彼此。这不是风格偏好：用
`dsh plugin add file:<dir>` 安装的插件是被**链接**进 profile 的，它从自己的目录解析模块，
所以一句 `import '@deepseek-ai/…'` 会恰好在最需要它的那次加载里炸掉——这条不变量由测试
断言，而不是靠信任。

## 许可

MIT，见 [LICENSE](LICENSE)。
