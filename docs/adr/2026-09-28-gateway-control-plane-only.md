# Gateway 仅作控制面，Runner 独占执行面

- Status: Accepted
- Date: 2026-09-28

## Context

Gateway 原先既是控制节点又是本地执行节点：它在自己的进程内注册
`LOCAL_RUNTIME_ID`，创建 `TransportRegistry`、`BrowserProfileManager`、
`ChromeProfileHost` 和 `LocalRuntime`，并把 `LocalRuntime` 注入
`ExecutionDispatcher`。Provider 的 `runtime.mode = local` 还是默认值。

结果是控制面与数据抓取面耦合：同一个进程既能路由和调度任务，又可以直接
接触目标网站、代理凭据和浏览器登录态。"谁来执行一次抓取"因此存在两条语义
完全不同的路径（Gateway 本地 vs 远程 Runner），而本地那条会把敏感状态带进
控制面进程。

详细设计与迁移顺序见 `docs/gateway-runner-boundary.md`。

## Decision

Gateway 只负责控制与调度，不再作为 Runtime：

- 不注册自身为 Runtime，`RuntimeRegistry` 只保存真正连接的 Runner；
- 不加载/实例化执行型 Provider，`ProviderRegistry` 收敛为 Provider 定义与
  调度要求（`nodeId` / `selector`）；
- 不创建用于 Provider 抓取的 Transport、BrowserHost、Browser Profile；
- 不读取或持有 Chrome Profile、Cookie、登录态。

Provider 实例化与全部真实网络访问、浏览器访问、登录态使用只发生在 Runner。

执行路径唯一：Gateway 调度 → 已连接 Runner → Provider 插件 → 目标站点。
没有可用 Runner 时返回明确的"无可用执行节点"错误（`NO_COMPATIBLE_RUNTIME`
/ `RUNTIME_OFFLINE`），不提供本地回退。

随之移除：`runtime.mode = local`、Gateway 自我注册的 `LOCAL_RUNTIME_ID`、
`LocalRuntime`、Gateway 侧的 `transports` / `browserProfiles` 配置段，以及
`GET /v1/browser-profiles` 端点。Gateway 配置收敛为
`server | auth | runnerTokens | runtimeRegistry | providers | routes`。

## Consequences

- 抓取能力与 Gateway 生命周期解耦：Gateway 可单独启动，提供管理、健康检查
  和 API，但不能执行真实抓取。
- 代理凭据、Cookie、Chrome 可执行路径等只存在于 Runner 配置，控制面不再
  持有这些秘密。
- Provider 配置进一步拆成 Gateway 的 Provider Definition 与 Runner 的
  Provider Deployment。Transport、Browser Profile 和 Provider Options 只存在于
  Runner Deployment；任务协议不再下发完整 `providerConfig`。
- 代价：任何抓取都要求存在一个在线且声明了相应能力的 Runner；Gateway 无法
  在单进程内自检端到端抓取。运维必须保证 Runner 可用性。
- Admin UI 的 Runtime 页面只展示 Runner，不再存在名为 `local` 的节点。

## Alternatives considered

- **保留 local 模式作为兜底**：控制面与执行面继续耦合，敏感状态回到 Gateway
  进程，与本次目标直接冲突，不采纳。
- **引入自动调度语义**（任意满足 Provider Type 的 Runner 都可承接）：这是一项
  独立能力，需要单独设计；本决策不引入隐式默认，避免再次出现"默认在哪里执行"
  的模糊语义。
- **保留 `LOCAL_RUNTIME_ID` 仅作状态展示**：它从未参与调度，却需要在注册表、
  调度器和 Admin 三处特判过滤，属于用特例维护的死数据，一并删除。
