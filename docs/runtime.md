# Gateway / Runner 执行架构

## 核心边界

Aylens 的执行链：

```text
AI Agent
  -> REST / MCP Adapter
  -> SearchService
  -> ProviderRouter
  -> ExecutionDispatcher
  -> Remote Runner
  -> Provider Plugin
  -> Runtime-local Transport / BrowserHost
  -> Internet
```

关键原则：

```text
Provider != Machine
Provider != Network
Provider != Proxy
Provider != Browser Profile
Provider != Routing
Provider != Retry Policy
Provider != Audit
```

Provider 定义“如何访问目标渠道”；Dispatcher 决定“去哪里执行”；Runtime 提供本地能力；Transport 决定“怎么出网”；BrowserHost 管理浏览器和登录态。

完整架构见 [architecture.md](./architecture.md)。

## Remote Runner

Runner 主动向 Gateway 建立 WebSocket 连接：

```text
Runner -> Gateway /v1/runners/connect
```

这样 Windows 桌面机不需要暴露入站管理端口。

Runner 注册时上报：

- Runtime ID
- OS / Hostname / Version
- 已加载 Provider type
- Browser capability
- Profile capability
- HTTP / browser automation capability
- Capacity

Gateway 根据 Provider 的 Runtime selector 选择合适 Runner。

## Provider Plugin 在 Runner 本地执行

Runner 不接收低级“点按钮 / 查 DOM”RPC。

Gateway 下发高层执行任务，Runner 在本地创建 Provider 并完整执行：

```text
Gateway
  -> EXECUTE
  -> Runner
  -> ProviderFactory
  -> Provider.search()
  -> local BrowserHost / Transport
  -> JOB_RESULT
```

站点逻辑、浏览器状态和网络秘密都留在执行机器。

## Runtime-local Transport

Transport Registry 只存在于 Runner Runtime。Gateway 不创建 Provider 抓取用 Transport，也不持有代理配置。

Provider 通过注入服务访问：

```js
create(id, config, services) {
  const transport = services.transports.get(
    config.transport?.primary ?? "direct"
  );
}
```

远程 Runner 的真实代理 URL 和凭据不需要传给 Gateway。

## BrowserHost

Browser automation 是 Runtime 服务，不是 HTTP Transport。

Provider 可通过：

```js
const profileId = config.browser?.profile ?? services.defaultBrowserProfile;

await services.browser.withProfile(
  profileId,
  context.jobId,
  async ({ context: browserContext }) => {
    const page = await browserContext.newPage();
    return result;
  }
);
```

BrowserHost 会：

1. 获取 Profile Lease；
2. lazy launch / attach Chrome；
3. 复用 BrowserContext；
4. 把 Context 交给 Provider；
5. 操作结束释放 Lease；
6. Runtime 关闭时清理 Aylens 自己创建的 Context。

`browser.defaultProfile` 由 Runner 注入给 ProviderFactory。`generic-browser` 已实现“Provider 显式 `browser.profile` 优先，否则使用 Runner 默认 Profile”；其他 Browser Provider 如果也要复用这一机制，应采用同样的 fallback 逻辑。

默认建议登录 Profile 使用：

```text
maxConcurrency = 1
```

避免同一个登录态被多个任务并发破坏。

## Persistent Profile

推荐给需要登录态的网站使用专门的 Aylens Profile：

```text
D:\Aylens\profiles\<profile-name>
```

不要直接使用日常 Chrome Profile。

登录完成后，同一个 Runner 可以复用 Cookies、Local Storage 等浏览器状态，这些内容不需要回传 Gateway。

## CDP attach

Chrome 由外部程序管理时可使用 mode: cdp。

在这种模式下：

- Aylens 连接现有 Chrome
- Aylens 不拥有 Chrome 进程
- BrowserHost shutdown 不会主动终止该外部 Chrome

## Profile affinity

浏览器状态天然属于本地 Runtime。

因此 Profile 任务不能静默漂移到一个没有相同登录态的 Runner。多 Runner 部署同一个 Provider ID 时，如果任务依赖特定 Profile，应在 Gateway 的 `runtime.selector.profile` 中显式加入 affinity；`browser.defaultProfile` 是 Runner-local 执行配置，不会自动转化成 Gateway selector。

## Runner 配置示例

```yaml
runner:
  id: windows-home-01
  gatewayUrl: "wss://aylens.example.com/v1/runners/connect"
  token: "${AYLENS_RUNNER_TOKEN}"
  heartbeatMs: 10000
  maxJobs: 2

plugins:
  baseDir: "."
  modules:
    - "builtin:generic-browser"
    # 也可以加载 ./providers/example.aylens-provider、外部 ESM 路径或 npm package

browser:
  defaultProfile: browser-main

providers:
  generic-browser:
    type: generic-browser

browserProfiles:
  browser-main:
    browser: chrome
    mode: launch
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\browser-main"
    channel: chrome
    headless: false
    interactive: true
    maxConcurrency: 1
    args: []
```

Runner capability 来自实际加载成功的 Plugin、Provider Deployment 与 Browser Profile，不需要在 YAML 中重复声明。

Runner 会随注册和心跳上报 Browser Profile 的安全运行状态（browser、mode、Lease、maxConcurrency、interactive、transport），供 Gateway Admin UI 展示；`userDataDir`、CDP endpoint、Chrome 可执行路径、Cookie、Local Storage 与凭据不会上报。
