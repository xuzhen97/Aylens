# Aylens

Aylens 是一个面向 AI Agent 的统一互联网 Retrieval Gateway，使用 Node.js / TypeScript 构建。

当前仓库重点是检索基础架构和分布式执行能力。真实搜索渠道（Google、Brave、X、知乎、小红书等）尚未接入；仓库中的 generic-browser 用于验证 Browser Runtime、Runner、登录态和完整检索链路。

## 已实现

- Fastify Gateway 与 API Key 鉴权
- 统一 SearchRequest / SearchResponse / SearchDocument
- Provider definition + ProviderFactory
- Provider Router 与 SearchService
- Local Runtime 与 Remote Runner
- Capability-based Runtime Registry
- Runner WebSocket 协议与 per-runner token
- Runner Provider Plugin 动态加载
- Direct / HTTP Proxy / SOCKS5 Transport
- Browser Profile Manager 与 Profile Lease
- Playwright + Google Chrome BrowserHost
- persistent Chrome profile
- CDP attach
- Runtime-local browser proxy
- generic-browser 验证 Provider
- 内存 Audit
- Admin UI
- MCP tool adapter definitions
- 单元测试与 Gateway/Runner 集成测试

核心执行链：

```text
AI Agent
  -> REST / MCP Adapter
  -> SearchService
  -> ProviderRouter
  -> ExecutionDispatcher
  -> Local Runtime / Remote Runner
  -> Provider Plugin
  -> Runtime-local Transport / BrowserHost
  -> Internet
```

Proxy credential、Chrome Profile、Cookie、Local Storage 等敏感状态保留在拥有它们的 Runtime 本地。

完整设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 快速开始

要求 Node.js 24+。

安装：

```bash
npm install
```

验证：

```bash
npm run typecheck
npm test
npm run build
```

启动 Gateway：

```bash
npm run dev
```

启动 Runner：

```bash
npm run dev:runner
```

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

默认配置没有 Provider，所以 /v1/search 成功返回空结果是正常行为。

更完整的启动说明见 [docs/getting-started.md](./docs/getting-started.md)。

## generic-browser 验证

仓库提供一个最小 Browser Provider：

```text
plugins/generic-browser/index.mjs
```

示例配置：

```text
config/examples/generic-browser.gateway.yaml
config/examples/generic-browser.runner.yaml
```

真实 Chrome smoke test：

```bash
npm run smoke:generic-browser
```

它会验证：

```text
Gateway
  -> Runner
  -> generic-browser Plugin
  -> BrowserHost
  -> persistent Chrome
  -> session reuse
  -> Gateway
```

详细运行和人工登录态验收见 [docs/operations.md](./docs/operations.md)。

## API 摘要

```text
GET  /health
GET  /ready

POST /v1/search
GET  /v1/providers
GET  /v1/runtimes
GET  /v1/audit/:requestId
GET  /v1/browser-profiles
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

支持跟随系统、亮色、暗色主题。

详见 [docs/admin-ui.md](./docs/admin-ui.md)。

## 常用命令

```text
npm run dev
npm run dev:runner

npm run typecheck
npm test
npm run build

npm run smoke:generic-browser
```

当前自动测试基线：

```text
12 个测试文件
27 个测试
```

详见 [docs/testing.md](./docs/testing.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](./docs/README.md) | 文档索引 |
| [docs/getting-started.md](./docs/getting-started.md) | 快速开始 |
| [docs/configuration.md](./docs/configuration.md) | 配置 |
| [docs/runtime.md](./docs/runtime.md) | Gateway / Runner / Browser Runtime |
| [docs/providers.md](./docs/providers.md) | Provider / Plugin / generic-browser |
| [docs/api.md](./docs/api.md) | REST 与 MCP adapter |
| [docs/admin-ui.md](./docs/admin-ui.md) | 后台 UI |
| [docs/operations.md](./docs/operations.md) | 运行、验收、故障排查 |
| [docs/testing.md](./docs/testing.md) | 测试与验证 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 完整架构设计 |

## 开发真实 Provider

通常只需要：

1. 实现 SearchProvider；
2. 暴露 ProviderFactory；
3. 打包成 Runner Plugin 或注册到 Local Runtime；
4. 使用注入的 Transport / BrowserHost；
5. 在 Gateway YAML 中配置 Provider instance；
6. 加到 route，或由请求显式指定 source。

正常情况下不应修改 SearchService、ExecutionDispatcher、RuntimeRegistry、Runner protocol 或 Gateway REST API。

详见 [docs/providers.md](./docs/providers.md)。
