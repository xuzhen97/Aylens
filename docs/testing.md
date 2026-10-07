# 测试与验证

```bash
pnpm test
pnpm typecheck
pnpm build

# 独立 Admin workspace
pnpm dev:admin
pnpm build:admin
pnpm test:admin
pnpm typecheck:admin

# 发布 Gateway Admin bundle（另含端到端源码外安装测试）
pnpm build:gateway
pnpm test:release
```

真实 Chrome smoke：

```bash
pnpm smoke:url-fetch
```

Git whitespace 检查：

```bash
git diff --check
```

自动化测试按根 Node/Vitest、Admin jsdom/Vitest 和独立 Release smoke 三层分别运行。Release smoke 会构建 Gateway、将产物复制到临时目录、安装生产依赖并启动 Gateway，需可访问依赖包注册表。Playwright 浏览器验收需 Gateway / Vite 开发服务可访问。

Vitest 默认不会启动真实 Google Chrome。浏览器相关单元/组件测试使用 fake BrowserHost、fake BrowserDriver 或 fake Playwright Page。

真实 Chrome 验证使用：

```text
pnpm smoke:url-fetch
```

## 测试矩阵

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/admin-session.test.ts`、`test/admin-auth.test.ts`、`test/admin-config-security.test.ts` | 管理会话生命周期、HTTP 白名单、CSRF、Origin、代理配置 |
| `test/admin-static.test.ts`、`test/admin-ui.test.ts` | Gateway SPA/资产托管、CSP、安全头、overview 脱敏与 Bearer 兼容 |
| 根 Node 测试目前 18 个测试文件，79 项通过；以本地命令为准 |
| `test/admin-release.test.ts`（`pnpm test:release`） | Gateway 发布内容、外置安装与实际 HTTP 冒烟测试 |
| `apps/admin/src/**/*.test.tsx`（`pnpm test:admin`） | React 页面、会话/主题 Hook、API client 与 XSS-safe 搜索结果 |

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

url-fetch：

- 仅允许 HTTP / HTTPS，拒绝 embedded credentials
- 公网目标校验：环回 / 私网 / 链路本地一律拒绝，无 allowPrivate 开关
- 原生 Markdown、HTML 静态提取、纯文本三条路径
- 挑战页 / 登录页 / JS 空壳的判定与各自失败语义
- 兜底不可用时返回已抓取的静态内容，但登录页仍必须失败
- 重定向逐跳复校验、响应解压与编码降级、限流截断
- 请求头：Accept 内容协商与 User-Agent（缺失 UA 会导致 403）
- 浏览器兜底：Profile 租约与取消后不进 callback

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

pnpm smoke:url-fetch：

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
pnpm smoke:url-fetch
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
- 所有新增 Provider 都自动安全

真实渠道上线前仍需要独立 Provider 测试、风控处理和运行监控。
