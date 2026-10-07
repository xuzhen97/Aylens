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
