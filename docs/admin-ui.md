# Admin UI

Aylens Gateway 内置轻量后台，不需要单独前端项目。

入口：

```text
http://127.0.0.1:3000/admin
```

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

## API Key

页面 HTML 可以直接打开，但管理数据仍由 Gateway API Key 保护。

API Key 只保存在：

```text
sessionStorage["aylens.admin.apiKey"]
```

请求通过：

```http
Authorization: Bearer <API_KEY>
```

API Key 不会：

- 写入 URL
- 写入页面 HTML
- 写入后端状态
- 写入 localStorage
- 从 Admin API 响应返回

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
API Key  -> sessionStorage
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

Gateway Provider Definition 不包含 Runner-local Browser Profile、Transport 或 Provider options，因此 Providers 页面也不会展示这些本地执行配置。

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
