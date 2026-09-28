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

完整架构见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。

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

每个 Gateway / Runner 都有自己的 Transport Registry。

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
await services.browser.withProfile(
  config.browser.profile,
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

因此 Profile 任务不能静默漂移到一个没有相同登录态的 Runner。调度时应把 profile 作为 capability / affinity 约束。

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
    - "builtin:generic-browser"\n    # 也可以加载外部 ESM 路径或 npm package

capabilities:
  browsers:
    - chrome
  http: true
  browserAutomation: true

transports:
  direct:
    type: direct

browserProfiles:
  account-main:
    browser: chrome
    mode: launch
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\account-main"
    channel: chrome
    headless: false
    interactive: true
    maxConcurrency: 1
    args: []
```

Provider type capability 来自实际加载成功的 Plugin，而不是 Runner YAML 中随意填写。
