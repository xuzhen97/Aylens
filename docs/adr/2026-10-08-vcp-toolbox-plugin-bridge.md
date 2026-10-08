# 以 VCPToolBox 插件暴露 Gateway 能力

- Status: Accepted
- Date: 2026-10-08

## Context

Aylens 的 Gateway 已经通过 REST 对外提供检索、Provider / Runtime 状态、登录态控制和审计查询，但 AI Agent 侧要接入还需要各自实现一套 HTTP 客户端。VCPToolBox 是本项目实际使用的 Agent 运行时，它通过 `pluginType: synchronous` + `communication.protocol: stdio` 的插件进程调用外部能力：宿主向插件 stdin 写一个 JSON，同步插件在退出时由宿主 `JSON.parse(stdout.trim())` 解析**整个** stdout。

同一时期，仓库里的 `src/api/mcp/tools.ts` 只定义了 `search` 与 `list_runtimes` 两个 tool adapter，且没有 wire transport。这意味着"Agent 能调用的能力集合"实际上散落在三处：REST 路由、MCP adapter 定义、以及未来的 VCP 插件——三套定义必然漂移。

参考实现是同一作者在 VCPDeck 项目里的 `VCPDeckBridge`（`packages/vcp-plugin` + `plugins/vcpdeck` + `dist/*.zip` + 根 `plugins.json`），本项目沿用它的形态。

## Decision

新增独立的 workspace 包 `packages/vcp-plugin`（`@aylens/vcp-plugin`），产出 VCPToolBox 插件 **AylensBridge**，只作为 Gateway REST API 的客户端存在。

**命令集是单一事实源。** `packages/vcp-plugin/src/commands.ts` 里的 `COMMANDS` 同时承载命令名、manifest description、示例参数和 handler；`scripts/bundle.mjs` 在构建时用它**反向生成** `plugins/aylens/plugin-manifest.json` 的 `capabilities.invocationCommands`。手写清单与实现之间那道必然漂移的缝从源头消除，而不是靠事后校验。当前命令集为 `Search`、`GetStatus`、`GetOverview`、`ListRuntimes`、`ListProviders`、`CheckProviderAuth`、`LoginProviderAuth`、`GetAudit`。

**产物形态对齐 PluginStore 的安装链路。** `plugins/aylens/` 下平铺 `plugin-manifest.json`、`index.cjs`、`config.env.example` 三个文件，并打成 `dist/AylensBridge.zip` 提交入库；根 `plugins.json` 提供 `name`、`version`、`path` 与 `downloadUrl`。PluginStore 的卡片安装按钮实际发送的是 `downloadUrl`（小 zip），整仓 `codeload` 下载只作为 `path` 子路径兜底。因此 `.gitignore` 使用 `dist/*` + `!dist/AylensBridge.zip`——目录级 `dist/` 会让白名单失效。

**插件零 npm 运行时依赖。** 使用 Node 内置 `fetch`，esbuild 以 `format: cjs`、`target: node18` 打成单文件 `index.cjs`，不引入 `@aylens/*` 运行时依赖，也不从 `src/` import。插件是独立分发的产物，必须自洽。

**凭据与副作用边界。** `config.env` 从 `process.cwd()`（宿主传入的 `plugin.basePath`）读取，并回退到环境变量——PluginStore 覆盖重装会把旧目录整体搬入 `.backup`，`config.env` 不在分发包内必然丢失，没有兜底就会每次重灌。`LoginProviderAuth` 是本插件唯一的强副作用命令（会在 Runner 上拉起可见 Chrome 并可能打断同 Profile 的进行中任务），默认关闭，需显式 `AYLENS_ALLOW_AUTH_LOGIN=true`，并要求 `confirm` 与 `providerId` 完全相同作为二次确认。VCPToolBox 的 `toolApprovalConfig.json` 只能按插件名整包审批，粒度不足以只拦一个命令，所以这道门开在插件内部。

**两个传输面由契约测试绑定。** `src/api/mcp/tools.ts` 扩展为与插件相同的命令集（进程内实现，直接使用 `GatewayContext`），并由 `test/vcp-plugin-contract.test.ts` 双向校验：命令集一致（仅 PascalCase / snake_case 命名差异）、每个工具声明的参数与插件描述中记录的参数一一对应、插件读取的每个配置项都在 `manifest.configSchema` 中声明。不采用共享代码包，因为两者的执行体不同（一个是进程内、一个是远程 HTTP），共享的只有契约；引入第三方共享包会带来构建顺序耦合，而根仓库目前没有 TypeScript project references。

## Consequences

- 新增一个命令的完整动作是：在 `commands.ts` 加一条 + 在 `src/api/mcp/tools.ts` 加同名工具 + `pnpm build:plugin`。漏掉任何一步都会被测试拦下。
- `plugins/aylens/index.cjs`、`plugin-manifest.json` 与 `dist/AylensBridge.zip` 都是入库的构建产物：方便本地直装与回滚，代价是每次改实现都要重新构建并提交，否则商店分发的仍是旧代码。`pnpm build:plugin` 会重新生成并自检 zip 条目与命令集一致性。
- `test/vcp-plugin-contract.test.ts` 读取的是仓库内的 `plugins/aylens/plugin-manifest.json`，因此它校验的是"已构建的产物"而不是源码。忘记构建会表现为契约测试与 manifest 一起停留在旧状态——这是刻意选择：契约测试的职责是保证"分发出去的东西"与 MCP adapter 一致。
- 插件只通过 REST 访问 Gateway，所以它无法绕过 API Key 鉴权，也无法触达 Admin 会话专属路由（Runner 代理配置管理仍只能经 Admin UI）。`GetOverview` 走的是允许 Bearer 的 `/v1/admin/overview`。
- `LoginProviderAuth` 默认关闭意味着远程触发人工登录需要改 Runner 侧的 `config.env` 并重新加载插件；这是有意的摩擦，因为该操作会打断同 Profile 的进行中任务。
- 插件侧不对文档正文做转义，Markdown 是 Aylens 的正式契约（见 `search-document-markdown-contract`），但注入给 AI 的正文有单篇 4k / 总量 28k 字符的上限，超限部分显式标注截断。
- 插件宿主会等待插件进程退出，因此 `communication.timeout` 必须覆盖浏览器兜底场景；默认 120s，`REQUEST_TIMEOUT_MS` 可调。插件在任何错误下都以 0 退出并输出合法 JSON——宿主只在 stdout 无法解析时才 reject。

## Alternatives considered

- **手写 `plugin-manifest.json` 的命令清单，用测试抓漂移**（VCPDeckBridge 的做法）：可行，但清单与实现仍是两份人工维护的文本。改为构建时生成后，契约测试只需关注"产物与 MCP adapter 是否一致"这一件事。
- **把命令定义抽成共享包，两个传输面都从它派生实现**：能进一步消除重复，但 MCP adapter 是进程内实现、插件是远程 HTTP 客户端，可共享的只有契约而非执行体；共享包还会让根包的 `tsc` 依赖另一个包的构建产物，而本仓库没有 project references。
- **让插件直接 import `src/` 的契约与类型**：能保证类型一致，但插件就再也不是可以脱离源码树分发的自洽产物；`index.cjs` 必须能单独放进 `Plugin/AylensBridge/` 运行。
- **不提供 `dist/AylensBridge.zip`，只依赖 GitHub 整仓下载**：省掉一个入库产物，但每次安装都要下载整仓、失去版本号（商店不会提示更新），且 `category` 会由启发式规则猜成 `browser`（"Bridge" 命中 `/chrome|bridge|capture|screenshot/`）。
- **把 `LoginProviderAuth` 交给 `toolApprovalConfig.json` 审批**：审批粒度是插件名，开启后会拦下包括 `Search` 在内的所有命令，不符合"只拦一个危险命令"的意图。
