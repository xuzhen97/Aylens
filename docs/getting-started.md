# 快速开始

## 当前项目状态

Aylens 是一个面向 AI Agent 的统一互联网 Retrieval Gateway。

当前仓库已经实现：

- Fastify Gateway
- API Key 鉴权
- Provider / ProviderFactory 抽象
- Local Runtime 与 Remote Runner
- Runner WebSocket 协议
- Runtime Registry 与 capability 调度
- Runner Provider Plugin 动态加载
- Direct / HTTP Proxy / SOCKS5 Transport
- Browser Profile / Lease
- Playwright + Google Chrome BrowserHost
- persistent profile 与 CDP attach
- generic-browser 验证 Provider
- 内存 Audit
- Admin UI
- MCP tool adapter definitions
- 单元测试与 Gateway/Runner 集成测试

当前还没有接入真正的搜索渠道，例如 Google、Brave、X、知乎、小红书。generic-browser 只是用于验证完整浏览器执行链路。

## 环境

要求：

- Node.js 24 或更高版本
- npm
- 如需真实浏览器测试：本机安装 Google Chrome

安装依赖：

```bash
npm install
```

基础验证：

```bash
npm run typecheck
npm test
npm run build
```

## 最小启动

启动 Gateway：

```bash
npm run dev
```

默认配置：

```text
config/aylens.yaml
```

启动 Runner：

```bash
npm run dev:runner
```

默认配置：

```text
config/runner.yaml
```

默认 Gateway 地址：

```text
http://127.0.0.1:3000
```

后台：

```text
http://127.0.0.1:3000/admin
```

默认开发 API Key：

```text
dev-key
```

默认配置没有 Provider，因此 /v1/search 返回成功但空结果，这是预期行为。

## generic-browser 快速验证

仓库包含：

```text
plugins/generic-browser/index.mjs
config/examples/generic-browser.gateway.yaml
config/examples/generic-browser.runner.yaml
```

Windows PowerShell 窗口 1：

```powershell
$env:AYLENS_CONFIG="./config/examples/generic-browser.gateway.yaml"
$env:AYLENS_API_KEY="dev-key"
$env:AYLENS_RUNNER_TOKEN="dev-runner-token"
npm run dev
```

Windows PowerShell 窗口 2：

```powershell
$env:AYLENS_RUNNER_CONFIG="./config/examples/generic-browser.runner.yaml"
$env:AYLENS_RUNNER_TOKEN="dev-runner-token"
npm run dev:runner
```

确认 Runner：

```powershell
curl.exe http://127.0.0.1:3000/v1/runtimes `
  -H "Authorization: Bearer dev-key"
```

读取公开页面：

```powershell
curl.exe -X POST http://127.0.0.1:3000/v1/search `
  -H "Authorization: Bearer dev-key" `
  -H "Content-Type: application/json" `
  -d '{"query":"https://example.com","sources":["generic-browser"]}'
```

也可以执行真实 Chrome smoke test：

```bash
npm run smoke:generic-browser
```

更完整的 Runner、人工登录态和故障排查见 [operations.md](./operations.md)。
