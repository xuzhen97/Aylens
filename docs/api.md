# API

## REST

当前 Gateway 提供：

```text
GET  /health
GET  /ready

POST /v1/search
GET  /v1/providers
GET  /v1/runtimes
GET  /v1/audit/:requestId
GET  /v1/browser-profiles
GET  /v1/admin/overview
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
/admin/profiles
/admin/audits
/admin/tester
```

## 鉴权

除 Runner WebSocket 的专用认证流程外，受保护的 /v1/* HTTP 接口使用：

```http
Authorization: Bearer <AYLENS_API_KEY>
```

默认开发配置：

```text
AYLENS_API_KEY=dev-key
```

## Search

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
  "sources": ["generic-browser"],
  "limit": 10
}
```

字段：

- query：必填
- route：可选 route
- sources：可选 Provider instance 列表；显式 source 优先
- limit：可选，最大 100
- language：可选

默认配置没有 Provider 时，Search 返回成功的空结果，这是故意设计的。

## Providers / Runtimes

```text
GET /v1/providers
GET /v1/runtimes
```

用于查看 Gateway 当前 Provider definition 与 Runtime Registry。

## Audit

```text
GET /v1/audit/:requestId
```

当前 Audit 是内存实现，Gateway 重启后记录不会保留。

后台使用：

```text
GET /v1/admin/overview
```

返回经过脱敏的 Gateway summary、Provider、Runtime、Browser Profile 与最近 Audit。

## Browser Profiles

```text
GET /v1/browser-profiles
```

这里只返回安全字段，不返回：

- userDataDir
- Chrome executable path
- CDP endpoint
- Chrome args
- Proxy credential

## MCP 当前状态

仓库目前提供的是 MCP tool adapter definitions：

```text
src/api/mcp/tools.ts
```

当前定义：

```text
search
list_runtimes
```

这些工具复用同一个 Gateway Context / SearchService。

当前仓库还没有接入完整 MCP SDK server / wire transport，所以不要把 adapter 定义误认为已经存在一个可独立连接的 MCP Server。

后续如果增加 MCP Server，应继续复用同一业务层，不复制 Search 逻辑。
