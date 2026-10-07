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
- pnpm 10.26+（仓库未在 `package.json` 中锁定 `packageManager`；pnpm 10.26 与 11 均可使用当前 workspace 配置）
- 如需真实浏览器测试：本机安装 Google Chrome

安装依赖：

```bash
pnpm install
```

```bash
pnpm dev:admin
pnpm --filter @aylens/admin typecheck
pnpm --filter @aylens/admin test
pnpm build:admin
pnpm build:gateway
```

构建产物会变成可直接部署的 Release：

```text
release/
├── README.md
├── ecosystem.config.cjs
├── pm2-start.ps1 / pm2-start.cmd / pm2-start.sh
├── gateway/
│   ├── aylens-gateway.mjs
│   ├── admin/                 # 已构建的 React Admin 静态资源
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
    ├── generic-browser.aylens-provider
    └── x-search.aylens-provider
```

在源码仓库里可直接运行：

```bash
pnpm start:gateway
pnpm start:runner
```

复制 `release/gateway` 或 `release/runner` 到另一台已有 Node.js 的机器后，在对应目录执行 `npm install --omit=dev`，再执行 `npm start` 即可。Gateway 产物已经包含 `admin/` 静态资源，无需前端服务器。

生产环境也可以使用 PM2。构建后的 `release/`、`release/gateway/`、`release/runner/` 都包含 `ecosystem.config.cjs` 和跨平台 `pm2-start` 脚本。安装 `pm2` 后，Windows PowerShell 执行 `./pm2-start.ps1`，Linux/macOS 执行 `./pm2-start.sh`；脚本会使用 `startOrRestart` 启动/更新进程并执行 `pm2 save`。

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

生产 Gateway 会同源提供管理前端，部署无需启动 Vite 或额外前端服务；默认地址为 `http://127.0.0.1:3000/admin`。Admin 登录复用 `auth.apiKey`，成功后使用两小时绝对有效的 HttpOnly 管理会话。

默认开发 API Key：

```text
dev-key
```
本仓库的默认配置已经把 generic-browser 验证 Provider 接进 `routes.default`，
并把 X Provider 接进独立的 `routes.x`。请同时启动 Runner，否则 /v1/search 会报找不到可用 Runtime。

## generic-browser 快速验证

这个 Provider 已在默认配置里接好：

```text
src/providers/generic-browser/index.ts                 官方 Provider 源码
release/providers/generic-browser.aylens-provider    独立 Provider 分发包
config/aylens.yaml                                  providers.generic-browser + routes.default
config/runner.yaml                                  generic-browser + x-search + browser-main Profile
```

X Provider 同样已在默认配置接好：`src/providers/x-search/index.ts` / `release/providers/x-search.aylens-provider` / Provider ID `x`。首次使用可在 `/admin/providers` 点击 `登录`，在 Runner 的可见 `browser-main` Chrome 中完成 X 登录，再点击 `检查状态`。

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
