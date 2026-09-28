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
npm install
npm run typecheck
npm test
npm run build
```

当前测试基线：

```text
12 个测试文件
35 个测试
```

## 2. 启动 generic-browser Gateway

默认配置 `config/aylens.yaml` 已接入 generic-browser。

需同时启动 Gateway 与 Runner，二者可以一条命令拉起：

```powershell
npm run dev:all
```

分开调试时的单进程命令：

```powershell
npm run dev
```

预期：

```text
http://127.0.0.1:3000
```

健康检查：

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/ready
```

## 3. 启动 Windows Runner

默认配置 `config/runner.yaml` 已加载 generic-browser 插件与 `generic-login` profile。

另一个 PowerShell：

```powershell
npm run dev:runner
```

Runner 应上报：

- Provider type：generic-browser
- Browser：chrome
- Profile：generic-login
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
npm run smoke:generic-browser
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

示例 Runner Profile：

```text
D:\Aylens\profiles\generic-login
```

不要使用日常 Chrome Profile。

Gateway 示例配置中可临时设置：

```yaml
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

登录状态只留在 Windows Runtime。

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

检查：

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

等待前一个任务释放 Lease，或使用不同 Profile。

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

1. npm run typecheck 通过；
2. npm test 通过；
3. npm run build 通过；
4. Gateway /health / /ready 正常；
5. Windows Runner online；
6. Runtime capability 与实际 Plugin/Profile 一致；
7. generic-browser 能读取 https://example.com；
8. 真实 Chrome smoke test 通过；
9. 人工登录后 authenticated page 能读取；
10. Runner 重启后 persistent profile 登录态仍存在；
11. Admin UI 不暴露 API Key、Runner Token、代理密码、本地 Chrome 路径。
