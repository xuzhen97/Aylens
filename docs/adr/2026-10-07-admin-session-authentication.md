# 共用 API Key 的受限管理会话认证

- Status: Accepted
- Date: 2026-10-07

## Context

Aylens Admin 原先将 Gateway API Key 保存于浏览器 sessionStorage，并在数据请求中携带 Bearer。独立前端需要明确的登录、退出和会话生命周期，同时保持现有业务 API 调用兼容。用户明确选择共用现有 `auth.apiKey`，不新增管理密钥或账号体系。

## Decision

Admin 登录使用现有 Gateway API Key，由 Gateway 校验后签发服务端内存管理会话。前端不持久化原始 Key；登录成功后清空输入与内存中的 Key，并删除旧版 Key 存储项。API Key 不进入 URL、页面、日志或普通管理请求。

会话使用至少 256 位密码学安全随机 ID，服务端以摘要索引，通过 `aylens.admin.session` Cookie 传递。Cookie 设置 `HttpOnly`、`SameSite=Strict`、`Path=/v1`，不设置 Domain；HTTPS 使用 `Secure`。仅允许 loopback 本地 HTTP 开发使用非 Secure Cookie，非 loopback HTTP 不建立登录会话。

会话绝对有效期为 2 小时，不因轮询续期。退出撤销当前会话，重新登录轮换当前会话；Gateway 重启清空所有会话。每次认证校验会话绑定的 API Key 指纹与当前生效配置，一旦变化即失效；不为此新增配置热加载。会话数量有上限并清理过期项。

业务 Bearer API Key 的已有认证行为保留。管理 Cookie 仅用于会话探测/退出，以及明确允许的方法与路由：

- `GET /v1/admin/overview`
- `POST /v1/search`
- `POST /v1/providers/:providerId/auth/login`
- `POST /v1/providers/:providerId/auth/check`

未来接口默认不接受管理 Cookie，权限按匹配路由和方法判定。存在 Authorization header 时只验证 Bearer，错误 Bearer 不回退 Cookie。Runner WebSocket 继续使用 Runner Token，管理会话不授予 Runner 身份。

登录校验同源 Origin、JSON 请求并实施有界限流。Cookie 认证的写操作校验同源 Origin 和会话绑定的 CSRF token；会话 token 通过同源响应获取，仅保存在前端内存。有效会话退出必须验证 CSRF；无效、过期或缺失 Cookie 仅可在同源校验通过后幂等清理。反向代理只信任显式配置的代理，不无条件信任客户端转发头，不开放跨源带凭据 CORS。

## Consequences

- **共享权限是明确取舍**：业务 API Key 持有人也能登录管理后台。独立前端和 Cookie 白名单不能为同一密钥建立管理员与业务调用方的身份隔离。
- 浏览器脚本不再长期持有原始 API Key，登录、退出及过期行为明确；HttpOnly 不能阻止 XSS 代用户调用已授权接口，仍需安全渲染和 CSP。
- 现有 Bearer 客户端不需要迁移。Cookie 的路径范围不是权限范围；新增管理能力必须显式审查授权白名单与 CSRF 要求。
- 内存会话适用于单 Gateway 进程，无数据库或共享会话服务；重启需要重新登录，不支持多实例会话一致性，也不提供注销所有设备的管理入口。
- 绝对过期避免轮询永久续期，但管理员连续使用超过 2 小时需要重新登录。
- 服务端承担 Cookie、限流、Origin、CSRF、指纹失效和资源清理的实现与回归测试责任。会话及敏感响应不缓存，日志不得记录凭据。
- 非本地部署必须配置 HTTPS；代理终止 TLS 时必须正确配置可信代理和外部来源。单进程限流不能替代边缘或分布式防护。
- 退出不保证取消已派发的 Runner 作业。

## Alternatives considered

- **继续在 sessionStorage 保存 Key 并发送 Bearer**：实现简单，但浏览器脚本长期持有高权限原始 Key，缺少可撤销的管理会话生命周期。
- **独立管理密钥**：可与业务调用方隔离权限，但用户明确选择共用现有 API Key，当前不采用。
- **完整用户体系与 RBAC**：支持多人身份、权限和审计归属，但超出当前可信管理员后台需求。
- **无状态会话令牌**：减少服务端状态，但退出撤销与密钥变更后的失效需要额外机制；当前选择可直接撤销的内存会话。
- **共享会话存储**：支持多实例，但增加基础设施和运维成本，当前部署不需要。
