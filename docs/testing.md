# 测试与验证

## 常用命令

全部测试：

```bash
pnpm test
```

TypeScript：

```bash
pnpm typecheck
```

Production build：

```bash
pnpm build
```

真实 Chrome smoke：

```bash
pnpm smoke:generic-browser
```

Git whitespace 检查：

```bash
git diff --check
```

## 当前基线

```text
13 个测试文件
50 个测试
全部通过
```

Vitest 默认不会启动真实 Google Chrome。浏览器相关单元/组件测试使用 fake BrowserHost、fake BrowserDriver 或 fake Playwright Page。

真实 Chrome 验证使用：

```text
pnpm smoke:generic-browser
```

## 测试矩阵

| 测试文件 | 测试数 | 主要内容 |
| --- | ---: | --- |
| test/config.test.ts | 9 | 环境变量插值、Gateway 默认段、Route / Provider 配置校验、Runner placement、共享默认 Browser Profile 校验 |
| test/runtime-registry.test.ts | 2 | Runtime capability 匹配与低负载选择、无匹配时报错 |
| test/profile-manager.test.ts | 1 | Profile Lease、并发限制、释放 |
| test/search-service.test.ts | 4 | 空 route、经已连接 Runner 执行、Audit |
| test/plugin-loader.test.ts | 2 | Runner Provider Plugin 动态加载、`.aylens-provider` 包加载 |
| test/transports.test.ts | 3 | HTTP Proxy、SOCKS5、错误标准化 |
| test/browser-host.test.ts | 2 | BrowserHost 复用、Lease、Runtime-local proxy |
| test/runner-session-manager.test.ts | 4 | Runner 结构化错误跨协议保真 |
| test/runner-reconnect.test.ts | 3 | Runner 重连与同一 id 接管 |
| test/generic-browser-provider.test.ts | 6 | URL 校验、正文提取、截断、keepPageOpen、取消信号、Runner 默认 Profile |
| test/generic-browser-integration.test.ts | 1 | Gateway/Runner WebSocket + generic-browser 结果 |
| test/runner-integration.test.ts | 4 | Runner 注册、capability、动态 Plugin |
| test/admin-ui.test.ts | 9 | Admin 多页面、主题、JS、鉴权、脱敏、Runner Profile 状态 |

总数：

```text
9 + 2 + 1 + 4 + 2 + 3 + 2 + 4 + 3 + 6 + 1 + 4 + 9 = 50
```

## 各层测试关注点

配置：

- 环境变量插值
- route 引用不存在 Provider
- 配置结构校验

Runtime Registry：

- OS
- providerType
- browser
- profile
- labels
- capacity

Profile Manager：

- maxConcurrency
- acquire / release
- PROFILE_BUSY
- active lease

SearchService：

- 默认 route 无 Provider 时成功空结果
- 经已连接 Runner 执行 Provider
- Audit 与 Provider metadata

Plugin Loader：

- Runner 动态加载 Provider Plugin
- `.aylens-provider` manifest、bundle 解包与动态加载
- capability 只来自实际成功加载的 Factory

Transport：

- HTTP proxy
- SOCKS5 proxy
- TCP 转发
- 错误标准化

BrowserHost：

- Profile Lease
- BrowserContext 复用
- Runtime-local Transport -> Browser proxy
- shutdown

Runner 协议：

- Runner 注册
- capability 上报
- 动态 Provider Plugin
- WebSocket job result
- 结构化错误码保真

generic-browser：

- 仅允许 HTTP / HTTPS
- 拒绝 embedded credentials
- title / body text
- 截断与 snippet
- keepPageOpen
- BrowserHost 注入

Admin UI：

- 六个独立 /admin 路由
- 页面只渲染自己的模块
- active nav
- system / light / dark 主题
- inline JavaScript 语法
- Admin API Bearer 鉴权
- 敏感配置脱敏
- 响应中不出现 Gateway 本地 Profile

## Smoke Test 与自动测试的区别

pnpm test：

- 快
- 稳定
- 不依赖本机 Chrome
- 适合 CI
- 验证边界与协议

pnpm smoke:generic-browser：

- 启动真实 Google Chrome
- 使用 persistent BrowserContext
- 走完整 Gateway -> Runner -> Plugin -> Chrome -> Gateway 链路
- 验证 session cookie 复用

人工登录验收：

- 依赖真实第三方站点
- 可能受验证码、风控、账号状态影响
- 不适合普通 CI
- 用于确认真实账号登录态和站点行为

## 推荐验证顺序

开发过程中：

```text
pnpm typecheck
pnpm test
pnpm build
```

修改浏览器 Runtime 后，再执行：

```text
pnpm smoke:generic-browser
```

发布或重要重构前，再按 [operations.md](./operations.md) 做一次人工 Gateway/Runner 验收。

## 测试通过不代表什么

50 个自动测试通过代表当前代码边界在测试覆盖范围内工作。

它不代表：

- 第三方网站永远可访问
- 账号不会失效
- 验证码不会出现
- 所有代理都可用
- Browser Profile 永远不会损坏
- 所有未来 Provider 都自动安全

真实渠道上线前仍需要独立 Provider 测试、风控处理和运行监控。
