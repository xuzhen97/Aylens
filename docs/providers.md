# Provider 与 Plugin

## Provider 的职责

Provider 只描述“如何访问某个渠道”。

它不应该负责：

- 机器选择
- Runtime 调度
- 全局重试策略
- Proxy 生命周期
- Browser Profile 调度
- Audit
- Cache

Provider 通过 Runtime 注入的服务使用网络和浏览器能力。

## ProviderFactory

Provider 实现通过 Factory 注册。

概念接口：

```ts
export interface ProviderFactory {
  readonly type: string;
  create(
    id: string,
    config: ProviderDeploymentConfig,
    context: ProviderFactoryContext
  ): SearchProvider;
}
```

Gateway Provider instance 和 Provider type 是不同概念：

```text
url-fetch     -> Provider instance
url-fetch     -> Provider implementation type
windows-generic-01  -> Runtime
browser-main       -> Browser Profile
```

同一种 Provider type 可以创建多个 Provider instance。

### Provider ID、Type 与 Implementation

Provider ID 是 Gateway/Runner 对齐的逻辑实例，Provider Type 是调度和协议能力，Implementation 才是具体代码。不同 Runner 可以为同一个 Provider ID/Type 加载不同实现，只要实现遵守相同 Provider 契约。

官方实现源码统一放在 `src/providers/<implementation>/`。正式构建时，内置实现会进入 Runner Bundle，不进入 Gateway Bundle；同一源码也可以构建成独立的 `.aylens-provider` 文件。Runner 用 `builtin:<implementation>` 加载内置实现，外部实现优先使用 `.aylens-provider` 分发，也继续兼容本地 ESM 路径或 npm package。无论来源如何，最终都必须导出同一个 Provider Plugin 契约。

## `enabled` 的默认值与运行时覆盖

`providers.<id>.enabled` 是**默认值**，不是当前生效状态：

- 生效值 = Gateway SQLite 覆盖值 ?? `config/aylens.yaml` 的 `enabled`。
- 覆盖层只保存"与配置文件的偏离"；没有覆盖行时完全跟随配置文件。
- 程序只读不写 `config/aylens.yaml`。决策依据见 `docs/adr/2026-10-10-runtime-provider-enablement.md`。

`enabled: false` 的请求语义：路由解析仍会选中该 Provider，请求在派发前被拒绝并返回 `PROVIDER_DISABLED`。该错误**不一定**伴随 HTTP 503：搜索接口照常返回 200，逐 Provider 的错误在 `meta.providers[].error` 里；只有错误冒泡到路由层时才映射为 HTTP 503。禁用**不会**让路由自动跳过它——需要调用方改换 `route` 或 `sources`。

## Runner Provider Plugin

Runner 不在 Gateway 中硬编码渠道。内置 Provider 随 Runner Bundle 发布；外部 Provider 推荐打成单个 `.aylens-provider` 文件，由同一套 Plugin Loader 加载：

```yaml
plugins:
  baseDir: "."
  modules:
    - "builtin:url-fetch"
    - "builtin:x-search"
    - "./providers/my-provider.aylens-provider"
    - "./external/my-provider/index.mjs"
    - "@my-company/aylens-provider-example"
```

Plugin 示例：

```js
export default {
  name: "example-plugin",
  version: "1.0.0",

  factories: [
    {
      type: "example-browser-provider",

      create(id, config, services) {
        return {
          id,

          async search(context, request) {
            // services.transports
            // services.browser
            // services.defaultBrowserProfile
            // config.options
            // const profileId = config.browser?.profile ?? services.defaultBrowserProfile

            return {
              items: [],
            };
          },
        };
      },
    },
  ],
};
```

Runner 会验证 Plugin metadata 并注册 Factory。

`.aylens-provider` 是 ZIP 容器，至少包含 `provider.json` 和已经 bundle 的 `index.mjs`。因此一个 Provider 可以作为单文件通过 GitHub Release、内网文件服务器或直接拷贝分发，不要求发布 npm。Runner 会校验 manifest，把 bundle 解到内容寻址缓存后动态加载。相对路径以 `plugins.baseDir` 为基准；原始 ESM 与 npm package 继续作为兼容加载方式。

只有实际加载成功的 Provider type 才会出现在 Runner capability 中。如果 Plugin import 失败或 descriptor 非法，Runner 会在注册 Gateway 前启动失败。

Plugin 属于可信本地代码。配置一个 module 等于允许它访问 Runner 进程和 Runtime-local 服务。

## url-fetch

仓库包含：

```text
src/providers/url-fetch/index.ts
```

它是 Aylens 官方内置 Provider。`pnpm build` 后它会包含在 `release/runner/aylens-runner.mjs` 中，同时生成 `release/providers/url-fetch.aylens-provider` 作为独立分发包；Gateway Bundle 中不包含这份 Provider 执行逻辑。Runner 通过 `builtin:url-fetch` 选择内置版本。

输入是一个 URL，输出归一化的 `SearchDocument`（Markdown + 纯文本）。

### 获取顺序

**能不用浏览器就不用**，只有静态获取确实不足时才启用浏览器：

```text
POST /v1/search
  -> SearchService
  -> ExecutionDispatcher
  -> Remote Runner
  -> url-fetch Plugin
  -> 1) HTTP 获取（Accept 偏好 text/markdown）
       - 命中原生 Markdown -> 直接使用
       - 否则静态提取（Readability + linkedom）-> Markdown / 纯文本
  -> 2) 仅当判定“需要渲染或有会话”时才尝试浏览器兜底
       - BrowserHost.withProfile(...) -> persistent Chrome -> page.goto(...)
  -> SearchDocument
  -> Gateway
```

- HTTP 阶段是匿名的：只发送 `Accept` 与 `User-Agent`，不携带 Cookie / Authorization。
- 浏览器兜底默认复用持久化 Profile（`browser-main`）的登录态。
- 两条路径不做并行竞速：HTTP 能出结果就不会启动 Chrome。

> `User-Agent` 必须显式发送。缺失时不少站点（Wikimedia 等）会直接返回 403，而 403 又会被判为“需要登录”并转入浏览器兜底，最终在未声明浏览器出口时整体失败。

### 目标限制

只接受：

```text
http://
https://
```

带嵌入式用户名密码的 URL 会被拒绝。

默认只允许公网目标：环回地址（`127.0.0.1`、`localhost`、`::1`）、私网、链路本地与保留地址一律拒绝，**没有 allowPrivate 开关**。域名解析后按校验过的固定 IP 建连，避免 DNS rebinding。因此本地 fixture 必须走离线测试路径，不能拿 localhost 当抓取目标。

### 出口：代理与浏览器

HTTP 阶段可以直接走代理，**与浏览器无关——不启动 Chrome 也能使用代理**：

```yaml
providers:
  url-fetch:
    transport:
      primary: proxy-main
      fallback: [direct]
    options:
      controlledProxyEgress: true
```

浏览器兜底的代理是另一条线，由 Browser Profile 自身的 `transport` 决定（见 [operations.md](./operations.md)）。

`controlledProxyEgress` / `controlledBrowserEgress` 是“Runner 所在机器已有受控出口”的**部署声明，不是实现出来的安全保证**：走代理时本地 DNS 解析与公网地址校验不再生效（DNS 由代理远端完成）。未声明却配置了代理或依赖浏览器兜底时，Provider 会明确拒绝（`NETWORK_POLICY_REJECTED`），而不是静默改走直连。

Gateway Provider Definition：

```yaml
providers:
  url-fetch:
    type: url-fetch
    enabled: true

    runtime:
      selector:
        os: windows
        providerType: url-fetch
        browser: chrome
        profile: browser-main

```

Runner Provider Deployment：

```yaml
browser:
  defaultProfile: browser-main

providers:
  url-fetch:
    type: url-fetch
    transport:
      primary: proxy-main
      fallback: [direct]
    options:
      controlledProxyEgress: true
      timeoutMs: 25000
      httpTimeoutMs: 8000
      contentMode: auto
      maxMarkdownChars: 100000
      maxTextChars: 50000
      snippetChars: 500
      browserFallback: true
```

全部 options 可选，且被严格校验：未知键直接报 `INVALID_REQUEST`，不会静默回退默认值。

| option | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | 25000 | 整个请求的总预算 |
| `httpTimeoutMs` | 8000 | HTTP 阶段预算；代理链路较慢时需要放宽 |
| `maxResponseBytes` / `maxDecodedBytes` | 2 MiB / 5 MiB | 压缩前 / 解压后的字节上限 |
| `maxDomElements` | 50000 | 解析的 DOM 节点上限 |
| `maxMarkdownChars` / `maxTextChars` / `snippetChars` | 100000 / 50000 / 500 | 各字段截断长度 |
| `contentMode` | `auto` | `auto` / `article` / `full` |
| `contentSelector` | — | 指定正文容器；选不中会明确失败 |
| `browserFallback` | `true` | 是否允许在需要渲染时尝试浏览器 |
| `fallbackOnHttpTimeout` | `false` | HTTP 超时后是否再试浏览器 |
| `controlledProxyEgress` / `controlledBrowserEgress` | `false` | 出口声明，见上文“出口”一节 |

浏览器兜底跑不起来时（未声明 `controlledBrowserEgress`、没有可用 Profile、Profile 忙），如果静态内容仍然可读，Provider 会返回它并在 `extensions.warnings` 里说明原因；登录页与挑战页不会这样处理，而是明确失败。

`url-fetch` 会优先使用显式 `provider.browser.profile`，未配置时使用 Runner 注入的 `services.defaultBrowserProfile`。其他 Browser Provider 若要共享同一浏览器工作区，也应实现相同 fallback。

Gateway 只用 Definition 做路由和调度；Runner 根据相同的 Provider ID 找到本地 Deployment，并使用本地执行配置创建 Provider。

结果会归一化成统一 SearchDocument：`markdown` 为 Markdown 正文，`text` 与 `snippet` 保持纯文本，`url` 是跟随重定向之后的最终地址，`canonicalUrl` 在页面没有有效值时回退为最终地址。

## x-search

仓库内置：

```text
src/providers/x-search/index.ts
```

Runner 通过 `builtin:x-search` 加载，也可以使用构建产物 `release/providers/x-search.aylens-provider`。默认 Provider instance 为 `x`，复用 Runner 的 `browser.defaultProfile`。

检索请求中的 `query` 直接使用 X 原生搜索表达式，Provider 打开 X 的 Latest 搜索时间线并滚动提取 Post。每条 Post 单独返回一个 `SearchDocument`：

```text
platform = x
type = post
```

结果包含 Post URL、正文、作者、发布时间和 X provider item id。

`x-search` 同时实现通用 Provider Auth Control：

```text
checkAuth()
openLogin()
```

Admin Providers 页面因此可以展示最近识别到的 X 账号与登录有效性，并提供 `登录 / 重新登录` 和 `检查状态`。

首次登录时点击 `登录`，Runner 会使用同一个 `browser-main` 用户数据目录启动**完全普通的 Chrome** 打开 `https://x.com/login`：没有 `--remote-debugging-port`，也不建立 Playwright/CDP 自动化连接；如果 Profile 配了 Transport，仍会带上 Chrome 自己的 `--proxy-server=...`。密码、2FA、验证码全部由用户直接在真实 Chrome 页面完成。完成登录后直接点击 `检查状态`；Aylens 会自动关闭自己启动的登录 Chrome、等待 Profile 释放，再用同一 Profile 启动 CDP Chrome 并临时 attach。

如果 X 将会话重定向到 `/login` 或 `/i/flow/login`，Provider 上报 `auth_required` 并让搜索返回 `PROFILE_AUTH_REQUIRED`。Runner heartbeat 只把最近账号显示信息、认证状态和检查时间上报 Gateway，不上传 Cookie、Token 或密码。

## Tavily（API 检索与凭据池）

仓库包含：

```text
src/providers/tavily/
```

它是 Aylens 官方内置的 API 型 Provider，提供两个独立能力：

- **Search**：`POST https://api.tavily.com/search`，返回搜索结果；
- **Extract**：`POST https://api.tavily.com/extract`，按显式 URL 列表取正文。

### 与浏览器完全无关

Tavily（以及后续接入的 Exa、AnySearch）都是**直接调用 HTTPS API**：

- 不获取 Browser Profile、不占用 Profile Lease、不启动 Chrome、不用 Cookie；
- 请求走 Runner 的 HTTP Transport（可用 `providers.tavily.transport` 指定代理）；
- 因此可以部署**不配任何 Browser Profile**的 API-only Runner —— 见 `test/api-only-runner.test.ts`。

服务商自己的服务端可能用网页爬取，那是它们的内部实现，与 Aylens 的浏览器资源无关。

### 凭据池（CredentialPool）

凭据池是 **API Key 池**，不是浏览器池。两者生命周期与安全语义完全不同：

| | CredentialPool | Browser Profile / Lease |
| --- | --- | --- |
| 管理对象 | 多个 API Key | 用户数据目录、登录态 |
| 调度动作 | 轮询、并发占用、冷却、分层限流 | Profile 占用与释放 |
| 敏感内容 | API Key | Cookie、Local Storage |

**Key 与池的唯一权威来源是 Runner 的 SQLite**，不由 YAML 覆盖。管理入口在
`/admin → API 凭据`，请求与回执经由与代理配置同一条安全通道（HTTPS/WSS、
本机 loopback 例外、版本冲突 409、断线视为“结果待确认”）。Gateway 只短暂转发
提交的 Key：不持久化、不回显、不写日志或审计；读取只返回 `maskedSecret`。

分层限流是核心：失败被分类为
`category`（auth / rate_limited / quota / invalid_request / network / upstream / item_content）与
`scope`（request / credential / account / endpoint_group / service / unknown）。同
账号（`account`）或同接口组限流时**不会继续轮换同组 Key** —— 换了也一样被拒；
请求参数错误与逐 URL 内容失败不会把 Key 标成坏的。

### 公共执行机制与后续服务商

每个 API 服务商都要做、且做错就会静默出错的四件事，统一由
`src/api-client/api-call-executor.ts` 承担：

1. 每次调用**占用一把凭据**并在 `finally` 释放（取消/超时/4xx 都不泄漏并发额度）；
2. 认证头**只发往受信 origin**，不跟随重定向；
3. 失败同时回报给凭据池与调用方，避免“池认为可用但接口报错”的分歧；
4. 网络/超时错误**不诬陷凭据**（不把 Key 标成坏的）。

服务商差异全部留在各自适配器里：端点与参数、原生批次上限、错误语义、
内容映射、用量解释。两类常见形状都已经有测试兵底：

| 形状 | 差异点 |
| --- | --- |
| Tavily | 原生批次 20；成败看 HTTP 状态 |
| Exa 类 | 原生批次可达 100；同 Team 共享限流与余额 |
| AnySearch 类 | 每次只取 1 个 URL（须自行有界并发）；HTTP 200 仍可能带业务失败码 |

“能承接新服务商”不是口头承诺：`test/provider-compat.test.ts` 用测试替身
逐项证明公共层不预设 Tavily 的形状（100 URL 不被迫拆批、单 URL 适配器并发受限、
业务码失败会落到凭据池），`test/credential-pool.test.ts` 证明账号级限流不轮换同组 Key。
替身仅用于测试，**不是可上线的 Exa / AnySearch 实现**。

### 调用示例

Gateway 默认把 `tavily` 设为 `enabled: false`（没配 Key 就不该默认产生付费调用），
在 Admin 启用并绑定池后可用：

```json
POST /v1/search { "query": "OpenAI 发布", "sources": ["tavily"], "limit": 5 }
POST /v1/extract { "urls": ["https://example.com/a"], "sources": ["tavily"] }
```

`/v1/extract` **必须显式给出 `sources`**：不复用 Search 的默认路由，也不默认并行
调用所有提取服务。既有 `url-fetch` 的 URL-as-query 入口保持不变。

### 用量与费用

- `include_usage`（部署 options 或 `SearchRequest.content`）可在响应中拿到本次消费；
- 用量必须区分来源与单位：官方统计（`accuracy: official`）、响应报告、本地估算三者不等价；
- **未知不是 0**，估算费用不是账单；不同服务商的 credits / requests / USD 不可直接比较；
- 自动提升搜索深度会增加费用，因此不作为默认行为。

### 数据披露与限制

把查询词与 URL 发送给 Tavily 属于向第三方披露，不同于本地 `url-fetch` 抓取；
结果内容是非可信文档数据，不得当作工具指令执行。上游错误 message 可能包含敏感
信息，一律不透传、不落日志；逐 URL 失败只返回本地固定文案与错误码。

Runner 数据库持有明文 Key，第一期**未做应用层静态加密**，数据库与备份必须按敏感
文件保护，不能宣称已加密。凭据池只协调本 Runner 的流量；多 Runner 共用同一账号时
本地限流不是全局限制。


## 人工登录态

`url-fetch` **不提供人工登录流程**：它的 HTTP 阶段是匿名的，也不会自动完成登录。需要登录态的页面有两条路：

1. 用 `x-search` 这类实现了 Auth Control 的 Provider 完成登录（见 [operations.md](./operations.md)）；
2. `url-fetch` 进入浏览器兜底时，会复用 `browser-main` Profile 里已有的 Cookie / Local Storage。

浏览器兜底需要部署方显式声明出口已受控，否则会被明确拒绝：

```yaml
providers:
  url-fetch:
    type: url-fetch
    options:
      controlledBrowserEgress: true
      browserFallback: true     # 默认值；置为 false 可彻底关闭兑底
```

登录状态始终留在 Runner 本地。

## 添加真实 Provider

通常只需要：

1. 实现 SearchProvider；
2. 暴露 ProviderFactory；
3. 官方实现放入 `src/providers/<implementation>/` 并注册为 builtin；需要独立分发的 Provider 构建成 `.aylens-provider`，也可继续使用 ESM/npm 兼容形式；
4. 使用注入的 Transport / BrowserHost；
5. 在 Gateway YAML 中增加 Provider instance；
6. 加到 route，或在请求里显式指定 source。

正常情况下不应该修改：

```text
SearchService
ExecutionDispatcher
RuntimeRegistry
Runner protocol
Gateway REST API
```

这些边界构成当前 Provider 扩展方式。完整架构见 [architecture.md](./architecture.md)。
