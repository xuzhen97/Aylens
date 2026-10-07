# url-fetch 的 HTTP 优先获取与浏览器最终兜底

- Status: Accepted
- Date: 2026-10-07

## Context

Aylens 的 generic-browser Provider 原先直接依赖浏览器，通过页面 innerText 获取内容，既消耗浏览器资源，也丢失标题、链接、代码块与表格结构。升级后的 url-fetch 需要获取 URL 对应的 Markdown，同时复用现有 Gateway → Runner 调度和 Transport 代理能力。静态内容无需浏览器，动态渲染或会话相关页面仍可能需要 Chrome。

## Decision

将 generic-browser 替换为 url-fetch，保留既有 SearchProvider.search 与 Gateway → Runner 执行边界，不新增独立获取 API。

采用顺序获取管线：首先通过 HTTP GET 表达原生 Markdown 内容协商偏好；收到 HTML 时本地提取并转换。只有静态结果显示合理的 JS 渲染或会话需求，才进行最后一次浏览器尝试。HTTP 与浏览器不并行竞速；HTTP 已得到有效内容时不启动浏览器，也不检查登录后是否存在更多内容。

HTTP 和浏览器共享正文提取与 Markdown 转换管线。静态 DOM 解析不执行脚本、不加载子资源。正文选择兼顾文章质量与文档结构，提取失败或内容短本身不作为浏览器升级的充分理由。

Provider 的 HTTP 能力不依赖 BrowserHost 或浏览器 Profile；仅在实际需要兜底时检查浏览器可用性。继续复用 Runner Transport，不默认依赖外部抓取 SaaS。

## Consequences

- 静态网页、原生 Markdown 和纯文本不会占用浏览器资源；浏览器仍覆盖部分动态页面及已有会话需求，但不保证绕过访问限制。
- 获取编排、HTTP 传输、内容提取、Markdown 转换及浏览器适配具有独立职责，可分别测试。两种获取路径的转换语义应保持一致。
- URL 安全拒绝、资源超限、不支持格式、404/410、429 与确定性配置错误不得通过浏览器兜底规避；兜底原因必须可观测。
- 所有获取阶段、Transport 回退、Profile 排队与清理共享总预算，并响应任务取消，不能每阶段重新计时。
- Transport 必须在读取与解压过程中限制资源，并正确处理编码、重定向和响应流异常；拿到整个字符串后截断不构成下载限制。
- 测试必须断言静态路径未调用浏览器，并覆盖动态兜底、内容结构保留及发布 Bundle/独立 Provider 包。具体依赖与默认阈值须通过验证，不由本 ADR 固定。
- 本决策不授权降低网络安全要求。Markdown 输出契约及持久化会话/出口安全边界由独立决策记录，不在此重复定义。

## Alternatives considered

- **继续浏览器优先**：可直接复用既有实现，但让静态请求承担 Chrome 成本与 Profile 排队，不满足避免不必要浏览器使用的目标。
- **仅 HTTP 获取**：实现与运行较轻，但无法覆盖需要 JS 渲染或浏览器会话的页面。
- **HTTP 与浏览器并行竞速**：可能降低部分请求延迟，却无法节省浏览器成本，增加重复访问与会话副作用。
- **默认使用外部 Reader SaaS**：可减少本地提取工作，但引入第三方可用性、配额、隐私与网络依赖，且现有 Runner 已具备必要基础设施。
