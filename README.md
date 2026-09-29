# Aylens

Aylens 是一个面向 AI Agent 的统一互联网 Retrieval Gateway，使用 Node.js / TypeScript 构建。

当前仓库重点是检索基础架构和分布式执行能力。真实搜索渠道（Google、Brave、X、知乎、小红书等）尚未接入；仓库中的 generic-browser 用于验证 Browser Runtime、Runner、登录态和完整检索链路。

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
  -> Remote Runner
  -> Provider Plugin
  -> Runtime-local Transport / BrowserHost
  -> Internet
```

Proxy credential、Chrome Profile、Cookie、Local Storage 等敏感状态只存在于 Runner。
Gateway 不访问目标网站、不创建 Transport、不启动 Chrome、不持有登录态；没有在线 Runner 时
搜索返回明确的“无可用执行节点”错误，不做本地回退。

完整设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

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
├── gateway/
│   ├── aylens-gateway.mjs
│   ├── package.json
│   └── config/aylens.yaml
├── runner/
│   ├── aylens-runner.mjs
│   ├── package.json
│   └── config/runner.yaml
└── providers/
    └── generic-browser.aylens-provider
```

Gateway 和 Runner 的 Aylens 业务代码分别合并为单一 Bundle；第三方 Provider 可以分发为单个 `.aylens-provider` 文件。内置 `generic-browser` 仍随 Runner Bundle 提供，同时也会产出独立 Provider 包作为标准分发物。

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

`dev:all` 会先等 Gateway `/ready` 通过再拉起 Runner，之后持续监督两个进程：
任何一侧掉线都会自动重新拉起（包括 `tsx watch` 重载后撞 `EADDRINUSE` 不再恢复的 Gateway）。
Runner 自身也带指数退避重连，所以先起 Runner、后起 Gateway 同样可行。
之后它持续监督两个进程：任何一侧因 `tsx watch` 重载而掉线，都会自动重新拉起。

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

默认配置已把 generic-browser 验证 Provider 接入 `routes.default`，
同时 Runner 侧默认加载内置模块 `builtin:generic-browser` 与 `generic-login` Profile。
两个进程都起来后，Admin UI 的 Providers 显示 1/1、Runtimes 显示 1/1（Gateway 自身不算节点）；
只起 Gateway 不起 Runner，/v1/search 会报无可用 Runtime。

更完整的启动说明见 [docs/getting-started.md](./docs/getting-started.md)。

## generic-browser 验证

仓库提供一个最小 Browser Provider：

```text
src/providers/generic-browser/index.ts
```

正式构建后，Runner 入口是 `release/runner/aylens-runner.mjs`；同一 Provider 源码还会生成 `release/providers/generic-browser.aylens-provider`，Gateway Bundle 不包含 Provider 执行逻辑。

默认配置已经挂上它了（`config/aylens.yaml` 的 `providers` + `config/runner.yaml` 的
`plugins.modules` 与 `generic-login` Profile），所以 `pnpm dev:all` 起来就能用。

真实 Chrome smoke test：

```bash
pnpm smoke:generic-browser
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
pnpm dev
pnpm dev:runner

pnpm typecheck
pnpm test
pnpm build

pnpm smoke:generic-browser
```

当前自动测试基线：

```text
13 个测试文件
42 个测试
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
3. 打包成 Runner Plugin；
4. 使用注入的 Transport / BrowserHost；
5. 在 Gateway YAML 中配置 Provider instance；
6. 加到 route，或由请求显式指定 source。

正常情况下不应修改 SearchService、ExecutionDispatcher、RuntimeRegistry、Runner protocol 或 Gateway REST API。

详见 [docs/providers.md](./docs/providers.md)。
