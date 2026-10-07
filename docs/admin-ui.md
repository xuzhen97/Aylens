Admin 迁移完成（2026-10-07）：React/Vite 前端位于 `apps/admin/`，由 Gateway 同源托管；认证使用既有 API Key 换取 2 小时绝对有效内存会话，生产要求 HTTPS 并显式信任代理。根、前端类型检查与测试、Gateway/Runner/Provider 构建、源码外 Release smoke 均通过。Playwright 图形验收未完成：本地开发服务无法从浏览器工具连接。

入口：

```text
http://127.0.0.1:3000/admin
```

Gateway 同源开发入口由 Vite 提供 `/admin/`。生产环境的 Gateway 不需要前端开发服务器。

Vite 默认代理 `/v1` 到 `http://127.0.0.1:3000`。开发 Gateway 时将 `server.publicOrigin` 显式设置为 `http://127.0.0.1:5173`（或当前 Vite Origin），然后设置 `AYLENS_CONFIG` 指向该本地配置。不要通过放宽 Origin/CSRF 校验来修复代理配置。

前端开发与验证命令：`pnpm dev:admin`、`pnpm --filter @aylens/admin typecheck`、`pnpm test:admin`、`pnpm build:admin`。Gateway 发布构建 `pnpm build:gateway` 会先构建前端并将产物复制到 `release/gateway/admin/`。

## 页面

后台已经拆分为独立页面：

```text
/admin               系统总览
/admin/runtimes      Runtime / Runner
/admin/providers     Providers
/admin/profiles      Browser Profiles
/admin/audits        检索审计
/admin/tester        请求测试
```

系统总览只展示：

- Gateway 状态
- Provider 统计
- Runtime 统计
- Browser Profile 统计
- Recent Audit 数量
- Runtime 摘要
- 最近检索摘要
- 快捷入口

详细内容分别在自己的页面，不再全部堆叠在一个长页面。

Gateway:

```text
http://127.0.0.1:3000/admin
```

Admin is an independent React/Vite workspace at `apps/admin/`, served by Gateway in production at the same origin. The existing Gateway API Key exchanges for a 2-hour in-memory admin session; it is not stored in browser Web Storage.

## API Key 与管理会话

登录页面使用现有 Gateway API Key，不建立独立管理员密钥或账号。原始 Key 仅通过登录请求提交，不写入 localStorage、sessionStorage、URL 或普通业务请求；服务端换发 2 小时绝对有效期的内存会话，浏览器持有 HttpOnly、SameSite=Strict、Path=/v1 Cookie。

管理会话在 Gateway 重启、API Key 变化、退出或绝对过期后失效。当前会话仅单实例内存保存；多 Gateway 实例需要 sticky session 也不能共享会话，应保持单实例部署。

Cookie 会话仅能访问管理 overview、搜索和 Provider 登录/状态检查的明确白名单。写操作要求同源 Origin 和 CSRF token。普通业务 Bearer API Key 与 Runner Token 认证边界维持独立；Bearer 错误时不会回退到 Cookie。

生产部署必须使用 HTTPS，Secure Cookie 会随 TLS 生效。若 TLS 在反向代理终止，需配置精确的 `server.publicOrigin`，并仅在 `server.trustProxy` 中列出受控代理 IP/CIDR。默认不信任代理，也不接受通配代理范围。

## 主题

右上角支持：

```text
跟随系统
亮色
暗色
```

主题偏好保存：

```text
localStorage["aylens.admin.theme"]
```

默认是“跟随系统”。

因此：

```text
主题偏好 -> localStorage
API Key -> 仅登录请求使用，随后从浏览器内存清除
```

## Runtime 页面

展示：

- Runtime ID
- Hostname
- OS
- Runtime / Runner version
- 状态
- Provider capability
- Browser capability
- Profile capability
- activeJobs / maxJobs
- 最近心跳

常见状态：

```text
online
degraded
draining
offline
```

## Providers 页面

展示：

- Provider ID
- Provider type
- enabled / disabled
- Runtime 选择策略
- 支持认证控制的 Provider：最近账号、登录状态、最后检查时间
- `登录 / 重新登录`
- `检查状态`

Gateway Provider Definition 不包含 Runner-local Browser Profile、Transport 或 Provider options，因此 Providers 页面也不会展示这些本地执行配置。

当前 `x-search` 使用这套通用认证控制。账号和有效性来自 Runner 最近一次真实检查或 X 搜索；页面不会后台定时访问 X 做保活。点击 `登录 / 重新登录` 时，Runner 会在同一个 persistent `browser-main` 中打开 `https://x.com/login`，用户直接在真实 Chrome 中完成密码、2FA 或验证码。

## Browser Profiles 页面

只展示 Runner capability 声明的远程 Profile。当前 Runner 会上报安全的 `profileDetails`，页面可展示：

- Runner ID
- Profile ID
- browser
- mode（launch / cdp）
- available / busy / draining / offline 状态
- activeLeases / maxConcurrency
- interactive
- Transport 逻辑名称

Gateway 不持有任何 Profile，也不再启动浏览器，因此不存在“Gateway 本地 Profile”。

为兼容旧 Runner，如果只上报逻辑 Profile ID 而没有 `profileDetails`，相关详细字段会显示“Runner 未上报”，不会伪造为 0。

不会显示：

- userDataDir
- Chrome executable path
- CDP endpoint
- Chrome args
- Proxy URL / credential

## Audit 页面

展示最近 30 条内存记录：

- 创建时间
- completed / partial / failed / running
- query
- requestId
- Provider
- Runtime
- 总耗时

URL 中常见敏感参数会脱敏，例如：

```text
token
access_token
api_key
password
secret
authorization
session
signature
```

值会显示为：

```text
***
```

当前 Audit 仍为内存实现。

## 请求测试

打开：

```text
/admin/tester
```

可直接调用：

```text
POST /v1/search
```

用于验证：

```text
Admin UI
  -> Gateway
  -> ExecutionDispatcher
  -> Runner
  -> Provider Plugin
  -> BrowserHost / Transport
  -> Gateway
  -> UI
```

如果请求状态为 failed 或 partial，请求测试页会直接显示每个失败 Provider 的：

- Provider ID
- Runtime ID（如果已经完成 Runtime 选择）
- 错误码
- 错误消息
- retryable
- latency
- requestId

因此不会再把 Provider 执行失败显示成笼统的“没有结果”。

## 安全边界

后台响应不应包含：

- Gateway API Key
- Runner Token
- HTTP/SOCKS5 Proxy credential
- Chrome userDataDir
- Chrome executable path
- CDP endpoint
- Provider options 原始内容
- Cookie / Local Storage
- 登录密码、2FA、站点 Token

selector labels 中类似以下敏感字段名也会被脱敏：

```text
token
secret
password
apiKey
credential
authorization
auth
```

Admin UI 是运行状态观察和基础测试工具，不等同于完整 RBAC、用户体系或持久化监控平台。
