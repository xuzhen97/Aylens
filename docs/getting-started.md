# 快速开始

## 当前项目状态

Aylens 是一个面向 AI Agent 的统一互联网 Retrieval Gateway。

当前仓库已经实现：

- Fastify Gateway
- API Key 鉴权
- Provider / ProviderFactory 抽象
- Gateway 纯控制面 + 远程 Runner 执行面（Gateway 不做任何抓取）
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
- pnpm 11
- 如需真实浏览器测试：本机安装 Google Chrome

安装依赖：

```bash
pnpm install
```

基础验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 最小启动

启动 Gateway：

```bash
pnpm dev
```

默认配置：

```text
config/aylens.yaml
```

启动 Runner：

```bash
pnpm dev:runner
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

默认配置没有任何 Provider 时，/v1/search 会成功返回空结果。
本仓库的默认配置已经把 generic-browser 验证 Provider 接进 `routes.default`，
所以请同时启动 Runner，否则 /v1/search 会报找不到可用 Runtime。

## generic-browser 快速验证

这个 Provider 已在默认配置里接好：

```text
plugins/generic-browser/index.mjs                  插件本身
config/aylens.yaml                                  providers.generic-browser + routes.default
config/runner.yaml                                  plugins.modules + generic-login Profile
```

所以一条命令即可（会自动拉起 Gateway 和 Runner）：

```powershell
pnpm dev:all
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
pnpm smoke:generic-browser
```

更完整的 Runner、人工登录态和故障排查见 [operations.md](./operations.md)。
