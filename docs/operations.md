# 运行与验收

本手册用于验证当前完整基础链路：

```text
Gateway
  -> Runner
  -> Provider Plugin
  -> BrowserHost
  -> Persistent Chrome
  -> SearchDocument
  -> Gateway
```

## 1. 基础检查

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

当前测试基线：

```text
13 个测试文件
50 个测试
```

## 2. 启动 Gateway 与 Runner（推荐）

默认配置已经接好 generic-browser —— Gateway 侧是 `config/aylens.yaml` 的 `providers` + `routes.default`，
Runner 侧是 `config/runner.yaml` 的 `plugins.modules` + `browser-main` Profile —— 因此一条命令即可：

```powershell
pnpm dev:all
```

它会先等 Gateway `/ready` 可访问再拉起 Runner，并持续监督进程。当前 `scripts/dev-all.ts` 的 Runner-ready 探针仍读取旧字段 `remoteRuntimes`，而 Gateway `/ready` 已返回 `runtimes`，因此脚本可能错误打印“runner has not registered yet”。实际 Runner 状态请以 `/v1/runtimes` 或 Admin UI 为准；这是当前代码中的已知字段漂移。

当前日志可能输出：

```text
[dev:all] gateway is up on http://127.0.0.1:3000
[runner] Aylens Runner connected: dev-runner
[dev:all] runner has not registered yet — the supervisor keeps watching for it
```

这里第三行是上面所述 `/ready` 字段漂移导致的误判；如果 `/v1/runtimes` 已显示 `dev-runner` 为 online，则 Runner 实际已经注册成功。

健康检查：

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/ready
```

`/ready` 当前返回 `{ "status": "ready", "runtimes": <数量> }`；Runner 注册后 `runtimes` 应为 `1`。Admin UI：

```text
http://127.0.0.1:3000/admin
```

## 3. 分开启动（排查时用）

需要单独观察某一侧、或要换一套配置时，开两个终端：

终端 1：

```powershell
pnpm dev
```

终端 2：

```powershell
pnpm dev:runner
```

两边默认都用 `config/aylens.yaml` / `config/runner.yaml`。要另起一套配置，复制一份再用环境变量指向它：

```powershell
$env:AYLENS_CONFIG="./config/aylens.local.yaml"
$env:AYLENS_RUNNER_CONFIG="./config/runner.local.yaml"
```

两边要成对改：Gateway 的 `providers.*.runtime.selector` 必须能匹配上 Runner 上报的能力
（providerType / browser / profile），否则请求会以 `NO_COMPATIBLE_RUNTIME` 失败。

Runner 注册后应上报：

- Provider type：generic-browser
- Browser：chrome
- Profile：browser-main
- browser automation capability

## 4. 验证 Runner 注册

```powershell
curl.exe http://127.0.0.1:3000/v1/runtimes `
  -H "Authorization: Bearer dev-key"
```

也可以打开：

```text
http://127.0.0.1:3000/admin/runtimes
```

应能看到 Runtime 为 online。

## 5. 验证公开页面

```powershell
curl.exe -X POST http://127.0.0.1:3000/v1/search `
  -H "Authorization: Bearer dev-key" `
  -H "Content-Type: application/json" `
  -d '{"query":"https://example.com","sources":["generic-browser"]}'
```

预期 SearchDocument 至少有：

- URL
- title
- text / snippet
- provider provenance
- runtimeId
- retrievalMethod

也可以在 /admin/tester 直接发请求。

## 6. 自动真实 Chrome smoke test

```bash
pnpm smoke:generic-browser
```

这个脚本会：

1. 启动临时 Gateway / Runner 链路；
2. 启动本机真实 Google Chrome；
3. 使用临时 persistent profile；
4. 第一次请求建立 session cookie；
5. 第二次请求访问受保护页面；
6. 验证同一个 BrowserContext 复用了 Cookie；
7. 清理临时 Profile。

它验证的是“真实 Chrome + 完整 Gateway/Runner 链路”，但不替代人工登录真实第三方站点。

## 7. 验证人工登录态

默认 Runner Profile 是 `browser-main`，目录在仓库内的 `./.profiles/browser-main`
（`config/runner.yaml` 的 `browserProfiles.browser-main.userDataDir`），不要指向日常 Chrome Profile。

默认是 `headless: true`，人工登录看不到窗口，需要先改成可见 + 交互模式：

```yaml
    headless: false
    interactive: true
```

`keepPageOpen` 属于 Runner Provider Deployment，不属于 Gateway 配置。可在 `config/runner.yaml` 中临时设置：

```yaml
providers:
  generic-browser:
    type: generic-browser
    options:
      keepPageOpen: true
```

流程：

1. 请求目标网站登录页；
2. Runner 打开可见 Chrome；
3. 手工完成登录；
4. 不关闭 Runner；
5. 再请求登录后的页面；
6. 验证返回内容包含 authenticated-only 内容；
7. 登录稳定后把 keepPageOpen 改回 false。

登录状态只留在实际执行该 Profile 的 Runner 本地。

## 8. 验证 Runner 重启后持久化

如果使用 persistent profile：

1. 完成人工登录；
2. 停止 Runner；
3. 不删除 Profile 目录；
4. 重新启动 Runner；
5. 请求 authenticated page；
6. 验证登录态仍然存在。

如果不存在，重点排查：

- 是否换了 userDataDir
- Profile 是否损坏
- 网站是否主动让 session 过期
- 是否启动了不同 Chrome Profile
- 是否多进程同时写 Profile

## 9. 客户端渲染页面

页面内容需要等待时可增加：

```yaml
options:
  postLoadDelayMs: 1000
```

只提取特定区域：

```yaml
options:
  textSelector: main
```

页面很大时调整：

```yaml
options:
  maxTextChars: 50000
  snippetChars: 500
```

## 10. 常见故障

### Runner 未出现

检查：

- gatewayUrl
- Runner Token
- Gateway runnerTokens
- Runner ID 是否与 token map key 对应
- WebSocket 是否被代理/防火墙阻断

Token 或 ID 对不上时 Gateway 会用 `1008 unauthorized runner` 关掉连接，日志表现为：

```text
Aylens Runner disconnected: Gateway closed the connection (1008 unauthorized runner)
```

Runner 会继续重试，但永远不会成功 —— 这时要改配置，不是等它。

### Runner 反复重连

Runner 自带指数退避重连（1s 起步、30s 封顶），以下日志都属于正常重连：

```text
Aylens Runner disconnected: Gateway closed the connection (1006)
Aylens Runner reconnecting (attempt 1) in 941ms
Aylens Runner could not reach ws://127.0.0.1:3000/v1/runners/connect (attempt 2, retrying in 1878ms): connect ECONNREFUSED
```

真正要查的是 Gateway 是否还在跑（推荐用 `pnpm dev:all`，它会自动把 Gateway 拉回来）。注意 Gateway 重启时偶尔会撞 `EADDRINUSE`，
这时 `tsx watch` 不会自己重试 —— 这正是 `pnpm dev:all` 要接管的场景。

### 同 id 的 Runner 被拒绝（1013）

```text
Aylens Runner disconnected: Gateway closed the connection (1013 runner id already connected: dev-runner)
```

已经有一个同 id 的 Runner 连着。Gateway **只接受一个**：新连接被拒（1013），不会踢掉旧的。

处理：停掉多余的那个，或者让它们用不同的 `runner.id`（同时把新 id 加进 Gateway 的 `auth.runnerTokens`）。
只有当旧连接累计 `runtimeRegistry.heartbeatTimeoutMs` 没有心跳时，新连接才允许接管这个 id。

### Runtime offline

检查：

- Runner 是否仍在运行
- heartbeat
- offlineAfterMs
- 网络是否断开

### NO_COMPATIBLE_RUNTIME

检查 Provider selector 是否要求了 Runner 没有的：

- OS
- providerType
- browser
- profile
- labels

### Chrome 无法启动

典型错误：

```json
{"code":"BROWSER_START_FAILED","message":"Failed to open browser profile: browser-main","retryable":true}
```

这里的 `retryable: true` 是有误导性的：如果原因是 Profile 被占用，重试必然还是失败。

最常见的原因是**残留的孤儿 Chrome 仍占着 userDataDir**。Chrome 是按 Profile 常驻缓存的，
只在 Runner 优雅退出时关闭；硬杀 Runner（关终端窗口、`taskkill /F`、进程崩溃）会把它留下来。
`pnpm dev:all` 会在拉起 Runner 之前自动回收命令行里带本仓库路径的 Chrome。

其余检查：

- 本机是否安装 Google Chrome
- Profile 是否被其他 Chrome 占用
- userDataDir 权限
- channel: chrome
- executable path 配置
- 浏览器代理是否可用

### PROFILE_BUSY

默认浏览器 Profile 通常：

```text
maxConcurrency = 1
```

Lease 是**立刻拒绝、不排队**的：并发请求不会等待，而是直接收到 PROFILE_BUSY。

处理：

- 等当前任务结束后重试；
- 或调大该 Profile 的 `maxConcurrency`（需确认目标站点能承受同一账号并发）；
- 或为并发场景准备多个不同 Profile。

如果某个任务长时不释放 Lease，先看它是不是已经超时：Gateway 超时会下发 CANCEL，
Runner 应随之终止浏览器工作并释放 Lease。若持续不释放，检查 `jobTimeoutMs`（Gateway）
是否小于该页面的实际耗时，以及 `timeoutMs`（Provider options）是否设得过大。

### 页面返回空文本

检查：

- postLoadDelayMs
- textSelector
- 页面是否在 iframe
- 页面是否需要登录
- 页面是否被风控 / 验证码阻断

### 代理失败

区分：

- Proxy 连接失败
- 目标站失败
- DNS 行为
- Runtime 本地环境变量
- Browser Profile 是否引用了正确 Transport

## 11. 最终验收清单

建议确认：

1. pnpm typecheck 通过；
2. pnpm test 通过；
3. pnpm build 通过；
4. Gateway /health / /ready 正常；
5. Runner online；
6. Runtime capability 与实际 Plugin/Profile 一致；
7. generic-browser 能读取 https://example.com；
8. 真实 Chrome smoke test 通过；
9. 人工登录后 authenticated page 能读取；
10. Runner 重启后 persistent profile 登录态仍存在；
11. Admin UI 不暴露 API Key、Runner Token、代理密码、本地 Chrome 路径。

### 生命周期保障

1. 杀掉 Gateway 再重新启动，Runner **无需人工干预**自己重连，检索随后恢复；
2. 启第二个同 id 的 Runner，它被 `1013 runner id already connected` 拒绝；第一个不受影响，两者也不再互相踢；
3. 让一次检索超时（例如把 `jobTimeoutMs` 设小，或指向一个不响应的地址）：超时后 Runtime 容量回到 0、
   Browser Profile Lease 被释放，紧接着的检索能立刻成功，而不是 PROFILE_BUSY。
