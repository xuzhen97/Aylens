# Aylens

Aylens 是一个面向 AI Agent 的统一互联网 Retrieval Gateway，使用 Node.js / TypeScript 构建。

当前仓库重点是检索基础架构和分布式执行能力。已接入 `x-search` 作为真实站点 Browser Provider；`url-fetch` 是 HTTP 优先的通用 URL 抓取 Provider——输入一个 URL，能不用浏览器就不用，只有静态获取不足时才最后启用浏览器兜底，输出 Markdown 与纯文本。其他搜索渠道仍按相同 Provider Plugin 契约扩展。

## 已实现

- Fastify Gateway 与 API Key 鉴权
- 统一 SearchRequest / SearchResponse / SearchDocument
- Provider definition + ProviderFactory
- Provider Router 与 SearchService
- Gateway 纯控制面 + 远程 Runner 执行面（**Gateway 不做任何抓取**）
- Capability-based Runtime Registry
- Runner WebSocket 协议与 per-runner token
- Runner Provider Plugin 动态加载
- Direct / HTTP Proxy / SOCKS5 Transport
- Browser Profile Manager 与 Profile Lease
- Playwright + Google Chrome BrowserHost
- persistent Chrome profile
- managed CDP：Runner 启动/复用普通系统 Chrome，再 attach
- Runtime-local browser proxy
- url-fetch：HTTP 优先的 URL 抓取（原生 Markdown 协商 → 静态提取 → 浏览器最后兜底）
- x-search：X 原生查询、Latest Post 提取、人工登录状态检测
- 内存 Audit
- Admin UI
- MCP tool adapter definitions
- VCPToolBox 插件 AylensBridge（synchronous/stdio，零 npm 运行时依赖，PluginStore 可安装）
- 单元测试与 Gateway/Runner 集成测试

核心执行链：

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

Proxy credential、Chrome Profile、Cookie、Local Storage 等敏感状态只存在于 Runner。
Gateway 不访问目标网站、不创建 Transport、不启动 Chrome、不持有登录态；没有在线 Runner 时
搜索返回明确的“无可用执行节点”错误，不做本地回退。

当前代码实现就是项目架构基线，完整边界见 [docs/architecture.md](./docs/architecture.md)。

## 快速开始

要求 Node.js 24+。

安装：

```bash
pnpm install
```

验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 会生成正式的 Release 产物：

```text
release/
├── README.md
├── ecosystem.config.cjs
├── pm2-start.ps1 / pm2-start.cmd / pm2-start.sh
├── gateway/
│   ├── aylens-gateway.mjs
│   ├── admin/                 # 已构建的 React Admin 静态前端
│   ├── package.json
│   ├── ecosystem.config.cjs
│   ├── pm2-start.*
│   └── config/aylens.yaml
├── runner/
│   ├── aylens-runner.mjs
│   ├── package.json
│   ├── ecosystem.config.cjs
│   ├── pm2-start.*
│   └── config/runner.yaml
└── providers/
    ├── url-fetch.aylens-provider
    └── x-search.aylens-provider
```

Gateway 和 Runner 的 Aylens 业务代码分别合并为单一 Bundle；第三方 Provider 可以分发为单个 `.aylens-provider` 文件。内置 `url-fetch` 与 `x-search` 都随 Runner Bundle 提供，同时也会产出独立 Provider 包作为标准分发物。

Release 同时生成 PM2 `ecosystem.config.cjs` 与 `pm2-start.ps1` / `pm2-start.cmd` / `pm2-start.sh`。可以在 `release/` 根目录同机管理 Gateway + Runner，也可以只复制 `gateway/` 或 `runner/` 后独立用 PM2 管理。详细命令见构建后的 `release/README.md`。

启动 Gateway：

```bash
pnpm dev
```

启动 Runner：

```bash
pnpm dev:runner
```

一次启动两者（Gateway + 测试 Runner，推荐）：

```bash
pnpm dev:all
```

`dev:all` 会先等 Gateway `/ready` 可访问再拉起 Runner，并持续监督两个进程。Gateway 不可达时会重启 Gateway；Runner 进程退出时也会由 supervisor 拉起。Runner 自身同时具备指数退避重连能力。

默认配置：

```text
config/aylens.yaml
config/runner.yaml
```

默认 Gateway：

```text
http://127.0.0.1:3000
```

Admin UI：

```text
http://127.0.0.1:3000/admin
```

默认开发 API Key：

```text
dev-key
```

默认配置把 url-fetch 验证 Provider 接入 `routes.default`，并增加 `routes.x -> x`。
Runner 默认加载 `builtin:url-fetch` 与 `builtin:x-search`。`x-search` 通过 `browser.defaultProfile=browser-main` 使用持久化 Profile；`url-fetch` 只在浏览器兜底阶段才会用到它。
默认 `browser-main` 不再由 Playwright 启动，而是 `mode: cdp + autoStart: true`：Runner 直接启动或复用系统 Google Chrome，然后 `connectOverCDP()`。如果 Profile 配置了 Runner-local `transport`，Runner 会把它转换成 Chrome 自己的 `--proxy-server=...` 启动参数。
两个进程都起来后，Admin UI 的 Providers 显示 2/2、Runtimes 显示 1/1（Gateway 自身不算节点）；
只起 Gateway 不起 Runner，/v1/search 会报无可用 Runtime。

更完整的启动说明见 [docs/getting-started.md](./docs/getting-started.md)。

## url-fetch：抓取一个 URL

HTTP 优先，**能不用浏览器就不用**：

```text
POST /v1/search { query: "https://example.com", sources: ["url-fetch"] }
  -> Gateway
  -> Runner
  -> HTTP 获取（匿名，只发 Accept 与 User-Agent）
       - 原生 Markdown 内容协商
       - 否则 Readability 静态提取 -> Markdown / 纯文本
  -> 仅当判定“需要渲染或有会话”时才启用浏览器兜底（persistent Chrome + 登录态）
  -> SearchDocument（markdown + text）
```

默认只允许公网目标：环回 / 私网 / 链路本地地址一律拒绝，没有开关可关。代理与浏览器兜底都需要在 Runner 配置里显式声明出口受控（`controlledProxyEgress` / `controlledBrowserEgress`），否则会明确拒绝，而不是静默改走直连。

`pnpm dev:all` 起来就能用（默认配置已挂载）。真实验证：

```bash
pnpm smoke:url-fetch
```

它做四件事：验证策略确实拒绝环回/私网、离线 fixture 的提取、可选的 `AYLENS_SMOKE_URL` 真实公网抓取，并明确报告没有跑真实 Chrome 兜底。

默认 `config/runner.yaml` 让 url-fetch 的 HTTP 阶段走 `proxy-main`，因此**不启动 Chrome 也能使用代理**；只有浏览器兜底才使用 `browser-main` Profile。详细选项与出口语义见 [docs/providers.md](./docs/providers.md)，运行与故障排查见 [docs/operations.md](./docs/operations.md)。

## X 搜索与登录

X Provider ID 默认是 `x`，实现类型是 `x-search`。调用时可以显式指定：

```json
{
  "query": "\"OpenAI\" lang:en",
  "sources": ["x"],
  "limit": 20
}
```

也可以使用 `route: "x"`。Provider 会打开 X 的 Latest 搜索结果并把每条 Post 归一化成 `SearchDocument`。

首次登录或登录失效时，打开 `/admin/providers`。X 卡片会展示最近识别到的账号、登录有效性与最后检查时间：

- `登录` / `重新登录`：用同一个 `browser-main` 目录启动不带 CDP 参数的普通 Chrome，并打开 `https://x.com/login`；
- `检查状态`：完成登录后直接点击；Aylens 会自动关闭自己启动的普通 Chrome，再用同一 Profile 启动 CDP Chrome 检查 X 登录状态；
- 密码、2FA、Cookie、Local Storage 都不会进入 Gateway，只保留在 Runner 的 persistent Chrome Profile。

人工登录与自动检索分成两个启动阶段：登录阶段是不带 remote-debugging 的普通可见 Google Chrome；检查状态/搜索阶段才启动 `127.0.0.1:9222` 的 CDP Chrome。切换时由 Aylens 自动关闭它自己启动的登录 Chrome并等待 Profile 释放。两个阶段使用同一个 `userDataDir`，所以 Cookie / Local Storage 会继续复用。

代理配置只在 Chrome 启动时生效。改了 `browserProfiles.browser-main.transport` 或代理地址后，需要先彻底关闭当前 `browser-main` Chrome，再重新触发一次浏览器操作。

## API 摘要

```text
GET  /health
GET  /ready

POST /v1/search
GET  /v1/providers
POST /v1/providers/:providerId/auth/check
POST /v1/providers/:providerId/auth/login
GET  /v1/runtimes
GET  /v1/audit/:requestId
GET  /v1/admin/overview
```

受保护的 /v1/* HTTP API 使用：

```http
Authorization: Bearer <AYLENS_API_KEY>
```

MCP 当前只提供 tool adapter definitions，还没有完整 MCP SDK server / wire transport。

详见 [docs/api.md](./docs/api.md)。

## Admin UI

后台已拆分为独立页面：

```text
/admin               系统总览
/admin/runtimes      Runtime / Runner
/admin/providers     Providers
/admin/profiles      Browser Profiles
/admin/audits        检索审计
/admin/tester        请求测试
```

生产 Admin 由 Gateway 在 `/admin` 同源托管，使用现有 API Key 换取 2 小时管理会话。前端开发/测试：`pnpm dev:admin`、`pnpm test:admin`、`pnpm typecheck:admin`；部署配置见 [docs/admin-ui.md](./docs/admin-ui.md)。

详见 [docs/admin-ui.md](./docs/admin-ui.md)。

## 常用命令

```text
pnpm dev:admin
pnpm test:admin
pnpm typecheck:admin
pnpm test:release

pnpm typecheck
pnpm test
pnpm build
```

详见 [docs/testing.md](./docs/testing.md)，分层测试结果以当前命令为准。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](./docs/README.md) | 文档索引 |
| [docs/getting-started.md](./docs/getting-started.md) | 快速开始 |
| [docs/configuration.md](./docs/configuration.md) | 配置 |
| [docs/runtime.md](./docs/runtime.md) | Gateway / Runner / Browser Runtime |
| [docs/providers.md](./docs/providers.md) | Provider / Plugin / url-fetch |
| [docs/api.md](./docs/api.md) | REST 与 MCP adapter |
| [docs/vcp-plugin.md](./docs/vcp-plugin.md) | VCPToolBox 插件 AylensBridge：命令、安装、配置、验收与排查 |
| [docs/admin-ui.md](./docs/admin-ui.md) | 后台 UI |
| [docs/operations.md](./docs/operations.md) | 运行、验收、故障排查 |
| [docs/testing.md](./docs/testing.md) | 测试与验证 |
| [docs/architecture.md](./docs/architecture.md) | 当前最终架构与职责边界 |

## 开发真实 Provider

通常只需要：

1. 实现 SearchProvider；
2. 暴露 ProviderFactory；
3. 打包成 Runner Plugin；
4. 使用注入的 Transport / BrowserHost；
5. 在 Gateway YAML 中配置 Provider instance；
6. 加到 route，或由请求显式指定 source。

正常情况下不应修改 SearchService、ExecutionDispatcher、RuntimeRegistry、Runner protocol 或 Gateway REST API。

详见 [docs/providers.md](./docs/providers.md)。
