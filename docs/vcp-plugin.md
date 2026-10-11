# VCPToolBox 插件：AylensBridge

AylensBridge 把 Aylens Gateway 的检索与运维能力暴露给 VCPToolBox 里的 AI Agent。它是一个 `pluginType: synchronous` + `communication.protocol: stdio` 的插件进程：宿主向 stdin 写一个 JSON，插件以 Gateway REST 客户端的身份执行，并把结果作为一个 JSON 写到 stdout。

插件**不含**任何 Gateway 逻辑，也不直接访问目标网站。所有执行仍在 Runner 侧完成，鉴权仍走 Gateway 的 API Key。架构取舍与边界见 [adr/2026-10-08-vcp-toolbox-plugin-bridge.md](./adr/2026-10-08-vcp-toolbox-plugin-bridge.md)。

## 命令

| 命令 | 参数 | 副作用 | 映射的 Gateway 接口 |
| --- | --- | --- | --- |
| `Search` | `query`（必填）、`sources`、`route`、`limit`、`language` | 无 | `POST /v1/search` |
| `GetStatus` | — | 无 | `GET /health` + `GET /ready` |
| `GetOverview` | `recentAuditLimit` | 无 | `GET /v1/admin/overview` |
| `ListRuntimes` | — | 无 | `GET /v1/runtimes` |
| `ListProviders` | — | 无 | `GET /v1/providers` |
| `CheckProviderAuth` | `providerId` | 无 | `POST /v1/providers/:providerId/auth/check` |
| `LoginProviderAuth` | `providerId`、`confirm` | **有** | `POST /v1/providers/:providerId/auth/login` |
| `GetAudit` | `requestId` | 无 | `GET /v1/audit/:requestId` |

`query` 的语义随渠道变化，不要混用：`url-fetch` 直接写 URL；`x-search` 写 X 检索式；API 型渠道（`tavily` / `exa` / `anysearch`）写自然语言检索式。`sources` 用逗号分隔，取值来自 `ListProviders`。

三条 API 渠道（`tavily` / `exa` / `anysearch`）在 Gateway 里**默认 `enabled: false`**（没配 Key 就不该发起付费调用），需要在 Admin 启用并绑定 Runner 凭据池后才会参与检索；插件侧只用 `ListProviders` 看它们的 `enabled` 与可用操作。它们的 `Search` 本身就能返回正文，因此**不要**再对同一批 URL 调一次 `Extract`。

### Extract 只对三家 API 渠道可用

`Extract` 的 `sources` 必须显式给出，且**只有声明了 `extract` 能力的 Provider 能用**：`tavily` / `exa` / `anysearch`。`url-fetch` 与 `x` 不提供该能力，填了会拿到 `NO_COMPATIBLE_RUNTIME`。三家的取舍：

| 来源 | 单次批量 | 正文格式 | 备注 |
| --- | --- | --- | --- |
| `tavily` | 20 | 可给 Markdown | |
| `exa` | 100 | **只有纯文本**，`markdown` 字段永不填充 | 要 `format: markdown` 时结果里会标出降级 |
| `anysearch` | 上游一次只接受 **1 个 URL** | 提取格式不定（永不为 markdown） | Aylens 侧有界并发（默认 2），URL 越多越慢 |

### 能力是查出来的，不是猜的

`ListProviders` 会为每个 Provider 附上一行**可用操作**，例如 `tavily=search,extract@windows-generic-01`。这个事实来自 Runner 心跳上报的 `providerOperations`，而不是插件或 Gateway 的配置猜测——Gateway 进程不加载 Provider 实现（factory 只在 Runner 侧注册），所以它自己回答不了「这个 type 支不支持 extract」。旧版 Runner 不上报该字段时，插件如实显示「未上报」，不谎报支持。

`ListRuntimes` 同样会渲染每个 Runner 的逐 Provider 能力行。

`LoginProviderAuth` 默认关闭：它会在目标 Runner 上拉起一个**可见的** Chrome 并打开登录页，可能打断复用同一 Browser Profile 的进行中任务，且不会等待登录完成。开启需要 Runner 侧改配置（见下），并要求 `confirm` 与 `providerId` 完全相同。

## 安装

### 从 PluginStore（推荐）

在 VCPToolBox 后台「插件商店」添加源，类型选 `github`，地址填仓库根：

```text
https://github.com/xuzhen97/Aylens
```

商店读取仓库根的 `plugins.json` 得到 `AylensBridge` 条目，卡片安装时下载 `downloadUrl` 指向的 `dist/AylensBridge.zip`。该 zip 内只有三个平铺文件（`plugin-manifest.json`、`index.cjs`、`config.env.example`），不含 `package.json`，因此安装过程会跳过 `npm install`。

### 手动上传

也可以直接在商店上传 `dist/AylensBridge.zip`，或把 `plugins/aylens/` 整个目录作为文件夹上传。

安装完成后插件落在 `Plugin/AylensBridge/`（Linux 服务器上通常是 `/opt/VCPToolBox/Plugin/AylensBridge/`）。

### 配置

复制 `config.env.example` 为 `config.env` 并填写：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AYLENS_BASE_URL` | `http://127.0.0.1:3000` | Gateway 地址；Gateway 是控制面，不执行抓取 |
| `AYLENS_API_KEY` | 无（必填） | 对应 `config/aylens.yaml` 的 `auth.apiKey` |
| `REQUEST_TIMEOUT_MS` | `120000` | 单次请求超时；url-fetch 可能触发浏览器兜底，不要设得过小 |
| `AYLENS_ALLOW_AUTH_LOGIN` | `false` | 是否允许 `LoginProviderAuth`；只认 `true` / `1` / `yes` / `on` |

配置读取顺序是 `config.env`（插件目录，即宿主传入的 `plugin.basePath`）→ 同名环境变量 → 内置默认值。VCPToolBox 会把 `config.env` 解析结果注入插件子进程的环境变量，所以覆盖重装导致 `config.env` 丢失时，环境变量仍能兜底；两者都没有时插件返回明确的 `CONFIG_ERROR`，不会静默失败。

改完 `config.env` 后在后台重新加载插件即可生效（插件是每次调用新起进程，不需要重启 VCPToolBox）。

### 更新

改实现后必须重新构建并推送，否则商店分发的仍是旧代码：

```bash
pnpm build:plugin      # 重新生成 index.cjs、plugin-manifest.json 与 dist/AylensBridge.zip
git add -A && git commit && git push
```

版本号要同时出现在 `package.json`、`plugins/aylens/plugin-manifest.json` 与根 `plugins.json` 三处；只有 `plugins.json` 的 `version` 是 `x.y.z` 形式，商店才会显示「可更新」。覆盖重装会把旧目录整体搬进 `Plugin/.backup/AylensBridge-<时间戳>/`。

## 开发与验收

```bash
pnpm build:plugin        # tsc → esbuild 单文件 CJS → 生成 manifest → 打 zip → 自检
pnpm test:plugin         # 插件单测：manifest 契约 + 分发/参数/配置
pnpm typecheck:plugin
pnpm --filter @aylens/vcp-plugin smoke   # stdio 契约冒烟：不依赖 VCPToolBox
pnpm test                # 根仓库测试，含 VCP 插件 ↔ MCP adapter 契约测试
```

三层验收各自负责不同的事：

- **单测**（`packages/vcp-plugin/test/`）验证分发、参数归一、错误映射与配置解析；
- **stdio 冒烟**（`scripts/smoke-stdio.mjs`）用一个本地 stub Gateway 复刻宿主行为，验证「stdout 恰好一个可解析 JSON」「exit 0」「stderr 无噪音」「环境变量兜底」这些真实链路里才会翻车的契约；
- **契约测试**（`test/vcp-plugin-contract.test.ts`）保证插件命令集与 `src/api/mcp/tools.ts` 的 MCP tool adapter 不漂移。

新增一个命令的动作：在 `packages/vcp-plugin/src/commands.ts` 加一条（命令名 + description + 示例参数 + handler），在 `src/api/mcp/tools.ts` 加同名工具，然后 `pnpm build:plugin`。漏掉任何一步测试都会变红。

**新增一个 Provider 也要动描述。** 命令集一致并不等于「AI 知道这个渠道存在」：AI 只能读到 manifest 里的 description 文本。所以新增检索渠道时，必须在 `Search`（以及 `Extract`，若该渠道支持）的描述里写明它的 ID、`query` 语义与批量和格式上的真实限制，否则渠道实现了也不会被用到。契约测试会校验 `Search` / `Extract` 的描述必须点名 `tavily` / `exa` / `anysearch` 与它们的关键事实，漏写直接变红。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `[AylensBridge:CONFIG_ERROR] 缺少 AYLENS_API_KEY` | `config.env` 与同名环境变量都没有；填 `AYLENS_API_KEY` |
| `[AylensBridge:GATEWAY_UNREACHABLE]` | `AYLENS_BASE_URL` 不通，或 Gateway 未启动；先用 `GetStatus` 之外的 `curl /health` 确认 |
| `[AylensBridge:AUTH_FAILED]` | API Key 与 `config/aylens.yaml` 的 `auth.apiKey` 不一致 |
| `[AylensBridge:TIMEOUT]` | 命中浏览器兜底或登录态检查；调大 `REQUEST_TIMEOUT_MS`，同时确认目标 Runner 的 Chrome 正常 |
| `Search` 报「无可用执行节点」 | 没有在线 Runner。`GetOverview` / `ListRuntimes` 查看节点状态；Gateway 不做本地回退，这是设计如此 |
| `Search` 返回空结果 | 合法空结果（Provider 已执行但没命中）。用 `GetOverview` 看近期审计、再用 `GetAudit` 看单次 Provider 事件定位 |
| `Search` 报 `PROVIDER_DISABLED` | 目标 API 渠道默认关闭；在 Admin 启用并绑定凭据池，或用 `sources` 改选其他渠道 |
| `Extract` 报 `NO_COMPATIBLE_RUNTIME` | 填了不提供 extract 的来源（`url-fetch`、`x`），或在线 Runner 没声明该能力。先用 `ListProviders` 看「可用操作」 |
| `ListProviders` 显示「可用操作: 未上报」 | 在线 Runner 版本较旧，不上报 `providerOperations`；或该 Runner 上没加载对应 Provider 实现 |
| `LoginProviderAuth` 报「默认关闭」 | 需要显式设 `AYLENS_ALLOW_AUTH_LOGIN=true` 并重新加载插件 |
| 商店里看不到新版本 | `plugins.json` 的 `version` 没改，或 zip 没推送；商店列表有 10 分钟缓存 |
| 插件调用无响应 | 宿主等待进程退出；检查 `communication.timeout` 是否被浏览器兜底场景耗尽 |
