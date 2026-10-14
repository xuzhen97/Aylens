# 以 DSH 原生工具插件暴露 Gateway 能力

- Status: Accepted
- Date: 2026-10-14

## Context

Aylens 的 Gateway 已通过 REST 对外提供检索、Provider / Runtime 状态、登录态控制与审计查询，VCPToolBox 侧的接入见 `vcp-toolbox-plugin-bridge`。DeepSeek Harness（DSH）是本项目实际使用的另一个 Agent 宿主，同样需要接入。

DSH 的插件模型与 VCPToolBox 完全不同。DSH 是一个 Cordis 应用，profile 是"有序的插件 bundle patch 层栈"：一个 npm 包只要声明 `dsh.bundle.patch` 指向自己的 patch YAML，就成为一个可装载的层；`dsh plugin --profile <name> add <spec>` 把参数转发给 pnpm，随后按**已安装状态**（不是依赖 diff）把声明了 `dsh.bundle` 的依赖并入 profile 的 `dsh.profile.bundles`。bundle 的 patch 在**自家包内**，所以插件装载不依赖 profile 根目录那份会被 `dsh-config-manager` 重写的用户层 `cordis.patch.yml`。

DSH 向模型暴露能力有两条已验证的路：

1. **原生工具**——`ctx.tools.register(defineTool({...}))`。工具 schema 自动进入系统提示词；参数由注册表校验；结果与呈现分离（`presentationMeta` 持久化结构化数据，`presentResult` 读回，UI 可渲染专用卡片）。
2. **技能 provider**——只注册一份 `SKILL.md`，正文尾部注入随包 CLI 的绝对路径，由模型自己用 shell 调用。零 `@deepseek-ai/*` 依赖。

检索是高频、结构化、需要参数校验与可引用来源的能力。走技能路线会把结构化结果压成纯文本，引入 shell 往返，并丢掉 UI 卡片与逐参数校验。

## Decision

新增 `packages/dsh-plugin`（包名 `aylens-dsh`），只作为 Gateway REST API 的客户端，声明 `dsh.bundle.patch`，以一个 Cordis 插件注册**四个原生工具**：`aylens_search`、`aylens_extract`、`aylens_inspect`、`aylens_login`。

**工具切分。** Search 与 Extract 各自成器，对应 `retrieval-capability-contracts` 的独立能力契约。六条诊断命令（GetStatus、GetOverview、ListRuntimes、ListProviders、CheckProviderAuth、GetAudit）合并进 `aylens_inspect` 的 `scope` 枚举——它们几乎不会被调用，逐条成器会给系统提示词塞进六份 schema。`LoginProviderAuth` 单独成器，以便独立门禁。

**产物自洽。** esbuild 打成单个 `dsh/index.mjs`，共享核心内联，`@deepseek-ai/*` 设为 external 交宿主解析。构建脚本**只允许覆盖 `dsh/index.mjs`，不得清空 `dsh/`**——同目录的 `cordis.patch.yml` 是手写源件，清掉它插件层会在下次启动时整层消失。`package.json` 的 `files` 必须包含 `dsh/`，否则装上却永远不会激活，且报错发生在很远的地方。

**呈现。** 结果与呈现分离：`aylens_search` 返回 `{ card: 'web', kind: 'search', sources, truncated }`，结构化的 sources 经 `presentationMeta` 随 `tool/result` 持久化、再由 `presentResult` 读回；`aylens_extract` 单 URL 走 `kind: 'fetch'`，多 URL 退回 `generic`（`fetch` 卡的 `url` / `statusCode` 是单数，装不下批量结果）。

**描述即能力可见性。** 两个检索工具的描述必须承载渠道语义：`url-fetch` 填 URL、`x-search` 填 X 检索式、`tavily` / `exa` / `anysearch` 填自然语言；API 渠道自带正文因此不必再对同一批 URL 发 Extract；各家的批量上限（tavily ≤20 且可给 Markdown、exa ≤100 且只有纯文本、anysearch 上游一次只接受 1 个 URL）。描述还须写明相对 DSH 内置 `web_search` 的不可替代场景（需登录态的站点检索、已知 URL 的浏览器兜底、多源与 Key 池），否则模型会默认走内置检索。

**凭据边界。** 非密配置（`baseUrl` / `requestTimeoutMs` / `allowAuthLogin`）走 patch 行的 `config:` 段。`AYLENS_API_KEY` 只经环境变量（优先 `$DSH_HOME/.env`），**不写进 `cordis.patch.yml`**：该文件会被 `dsh-config-manager` 重写，也会被配置同步与备份链路带走。

**危险操作门禁开在插件内部。** `allowAuthLogin` 默认 `false`，并要求 `confirm` 与 `providerId` 全等作为二次确认。基线**不**依赖 DSH 的审批 seam——文档明确 `ask` 在未部署 approval seam 时会退化成拒绝，把一个会莫名永久失败的机制当默认行为是不可接受的。

**交付。** 先走本地路径安装（`dsh plugin --profile desktop add <path>`），验收通过后再议是否发 npm。回滚是一条 `remove`。

## Consequences

- 新增一个能力的完整动作是：共享核心加一次操作 + 两个宿主各自的适配（VCP 命令 / DSH 工具）+ 两侧重建产物 + 两侧版本号同步。
- 工具名是公开接口：模型会记住它们，改名是破坏性变更。四个工具都不声明 `isConcurrencySafe`，因此在并行工具调用下 Aylens 工具是排序屏障——刻意取舍，不是遗漏。
- 插件激活失败会让四个工具整体消失，比单次调用失败更难诊断。因此缺 `AYLENS_API_KEY` 时不在激活期抛错，而是每次调用返回带 `CONFIG_ERROR` 的明确错误。
- DSH 侧不共享 `src/api/mcp/tools.ts` 的进程内实现，只共享 REST 契约。
- 插件只经 REST 访问 Gateway，无法绕过 API Key 鉴权，也触达不到 Admin 会话专属路由。

## Alternatives considered

- **技能 provider + 随包 CLI**（`vcpdeck` / `siyuan-agent` 的形制）：零 `@deepseek-ai/*` 依赖、最稳，但结果只能是纯文本，丢掉逐参数校验与 UI 卡片，检索来源的结构化引用也保不住，不采用。
- **一个 `aylens` 工具 + `command` 枚举**（与 AylensBridge 完全同构）：系统提示词最省，但参数只能给自由对象，丢掉 schema 校验与呈现卡，模型更易填错，不采用。
- **九个工具一一对应**：schema 最精确，代价是六份几乎不会被调用的诊断 schema 常驻提示词，不采用。
- **把 Aylens 做成 MCP server 供 DSH 的 MCP 客户端消费**：跨宿主通用，但 Aylens 目前只有 tool adapter 定义、没有 server 与 wire transport，且每次调用多一跳，本次不做。
- **一开始就发 npm 公开包**：与 `dsh-tool-mermaid` / `dshmarket` 同形制，但本地路径已足够自用与验收，先不发。
