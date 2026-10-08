# API

## REST

当前 Gateway 提供：

```text
GET  /health
GET  /ready

POST /v1/search
GET  /v1/providers
POST /v1/providers/:providerId/auth/check
POST /v1/providers/:providerId/auth/login
GET  /v1/runtimes
GET  /v1/audit/:requestId
GET  /v1/admin/overview
GET  /v1/admin/runners/:runnerId/proxy-config
POST /v1/admin/runners/:runnerId/proxy-config
POST /v1/admin/session/login
GET  /v1/admin/session
POST /v1/admin/session/logout
```

Runner WebSocket：

```text
/v1/runners/connect
```

后台页面：

```text
/admin
/admin/runtimes
/admin/providers
/admin/proxies
/admin/profiles
/admin/audits
/admin/tester
```

`GET /ready` 当前返回 Gateway 自身 ready 状态和 Runtime Registry 中的 Runner 数量，例如：

```json
{
  "status": "ready",
  "runtimes": 1
}
```

`/ready` 不要求所有 Runner 在线；它本身不是 Provider 可用性探针。

## 鉴权

除 Runner WebSocket 的专用认证流程外，受保护的 /v1/* HTTP 接口使用：

```http
Authorization: Bearer <AYLENS_API_KEY>
```

默认开发配置：

```text
AYLENS_API_KEY=dev-key
```

## 管理会话

Admin 登录使用 `POST /v1/admin/session/login`，请求 JSON `{ "apiKey": "<现有 Gateway API Key>" }`。成功时返回 `{ "authenticated": true, "expiresAt": <毫秒时间戳>, "csrfToken": "<随机 token>" }` 并设置 `aylens.admin.session` HttpOnly Cookie；会话绝对有效 2 小时。

`GET /v1/admin/session` 探测当前会话；`POST /v1/admin/session/logout` 需同源 Origin 和 `X-CSRF-Token`，成功后撤销并清除 Cookie。所有 session 响应使用 no-store。

Cookie 会话只授权 `GET /v1/admin/overview`、`POST /v1/search`、Provider auth login/check,以及 `GET/POST /v1/admin/runners/:runnerId/proxy-config` 指定路由。所有写请求校验精确 Origin 与 CSRF。`Authorization: Bearer` 认证和 Runner Token 不受 Cookie 影响;无效 Bearer 绝不回退到 Cookie。

通过 HTTPS 部署可设置 Secure Cookie。TLS 反向代理需显式设置 `server.publicOrigin`，并限制 `server.trustProxy` 到实际代理 IP/CIDR。生产环境必须在 HTTPS 下使用管理登录。

请求：

```http
POST /v1/search
Content-Type: application/json
Authorization: Bearer dev-key
```

示例：

```json
{
  "query": "https://example.com",
  "sources": ["url-fetch"],
  "limit": 10
}
```

字段：

- query：必填
- route：可选 route
- sources：可选 Provider instance 列表；显式 source 优先
- limit：可选，最大 100
- language：可选

未配置 Provider（或路由为空）时，Search 返回成功的空结果，这是故意设计的。

## Providers / Runtimes

```text
GET /v1/providers
GET /v1/runtimes
```

用于查看 Gateway 当前 Provider definition 与 Runtime Registry。

支持人工网页登录的 Provider 还提供：

```text
POST /v1/providers/:providerId/auth/check
POST /v1/providers/:providerId/auth/login
```

`auth/check` 在目标 Runner 的 Browser Profile 中检查最近登录状态；`auth/login` 打开 Provider 的真实登录页。响应只包含 `authenticated / auth_required / unknown`、账号显示信息、检查时间和 Runtime ID，不返回 Cookie、Token、密码或 Profile 本地路径。

## Audit

```text
GET /v1/audit/:requestId
```

Audit 持久化在 Gateway 本地 SQLite:写入前脱敏(HTTP URL 去除用户信息、全部查询参数与 fragment,摘要最多 500 字符),默认保留 30 天;重启后遗留的运行中请求标记为 `interrupted`。响应使用与存储相同的安全数据,不含未保存的原始查询。

后台使用:

```text
GET /v1/admin/overview
```

返回经过脱敏的 Gateway summary、Provider、Runtime 与最近 Audit。

## Runner 代理配置

```text
GET  /v1/admin/runners/:runnerId/proxy-config
POST /v1/admin/runners/:runnerId/proxy-config
```

仅允许操作在线且支持配置通道(`capabilities.proxyConfig`)的 Runner;携带凭据的写入要求 HTTPS + WSS(loopback 开发连接例外)。

- GET 返回脱敏安全视图:代理 ID、类型、非凭据地址、是否配置认证、Provider/Profile 引用、配置版本;
- POST 接受一次原子修改(put/delete/bind),携带 `operationId` 与 `expectedVersion`;版本过期返回 409 `CONFIG_VERSION_CONFLICT`,代理被引用返回 409 `CONFIG_IN_USE`,无效请求返回 400,Runner 离线/不支持/结果待确认返回 503。

凭据仅写入:查询不返回原值;编辑支持保留、替换或清除。连接中断或回执超时时返回 `CONFIG_RESULT_UNKNOWN`(结果待确认),应重新读取配置核对,不要盲目重发。HTTP 代理修改后新任务立即生效;浏览器 Profile 引用的代理需重启对应 Chrome 才能生效。

## MCP 当前状态

仓库目前提供的是 MCP tool adapter definitions：

```text
src/api/mcp/tools.ts
```

当前定义：

```text
search
get_status
list_runtimes
list_providers
get_overview
get_audit
check_provider_auth
login_provider_auth
```

这些工具复用同一个 Gateway Context / SearchService。`login_provider_auth` 与 `get_overview` 分别对应真实副作用与 `/v1/admin/overview`。

这组定义与 VCPToolBox 插件 AylensBridge 的命令集由 `test/vcp-plugin-contract.test.ts` 双向绑定：两边命令集或参数名不一致时测试会失败。插件侧的安装、配置与命令说明见 [vcp-plugin.md](./vcp-plugin.md)。

当前仓库还没有接入完整 MCP SDK server / wire transport，所以不要把 adapter 定义误认为已经存在一个可独立连接的 MCP Server。
