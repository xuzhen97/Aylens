# SearchDocument 的可选 Markdown 输出契约

- Status: Accepted
- Date: 2026-10-07

## Context

Aylens 的 SearchDocument 已使用 text 表达纯文本、snippet 表达短摘录。url-fetch 需要保留网页的标题层级、链接、列表、代码块和表格，单纯的纯文本无法满足这一需求。直接把 Markdown 放入 text 会改变既有字段语义，让不同 Provider 和下游消费者产生不一致理解。

## Decision

为 SearchDocument 增加可选字段 `markdown?: string`，表达文档的 Markdown 内容。其他 Provider 不必提供该字段，既有纯文本消费方式保持有效。

url-fetch 成功获取内容时同时提供 Markdown 与纯文本：markdown 保留内容结构，text 为纯文本，snippet 为短纯文本摘录。转换不承担总结或改写原文的职责。

url 表达实际最终访问地址；canonicalUrl 使用解析并验证后的页面 canonical，缺失或无效时回退为最终访问地址，不为 canonical 额外发起请求。获取来源继续放入 provenance；实际引擎、提取方式、状态、截断及兜底原因等诊断信息放入 extensions，不包含 Cookie 或认证头等凭据。

Markdown 是非可信文档内容，不是安全 HTML，也不是可执行指令。

## Consequences

- 新字段是可选的，其他 Provider 不需要同步生成 Markdown。消费者可明确选择结构化阅读或纯文本处理，不依赖 Provider 名称猜测 text 的格式。
- 契约类型、响应校验及 Gateway/Runner 传输路径必须保持该字段，集成测试须证明 Markdown 不会在序列化或校验中被丢弃，同时保持纯文本兼容性。
- Markdown 转换应保留代码块缩进、围栏、列表、表格和链接，不得复用会合并空白的纯文本规范化逻辑。输出被截断时必须标记，并尽量避免破坏块结构。
- 同时返回 Markdown 和纯文本会增加响应体积，需要分别约束输出规模；两者的限长应有明确、可测试的语义。
- 原生 Markdown 可以直接处理，不需要转回 HTML 再转换；其内容仍须经过必要的危险内容处理和资源限制。
- 下游渲染 Markdown 时必须禁用危险原始 HTML 或清理最终 HTML，不能把格式转换当作安全保证。网页自然语言内容应被当作数据，不以删除指令关键词替代信任边界。
- 本决策只定义输出语义，不新增独立 fetch API，不规定所有 Provider 必须实现 Markdown，也不引入自动摘要能力。

## Alternatives considered

- **把 Markdown 写入 text**：不增加字段，但破坏纯文本语义，使既有消费者难以区分文本与 Markdown。
- **仅放入 extensions.markdown**：容易扩展，但将主要文档内容藏入通用扩展字段，缺少明确类型契约，不利于消费者发现和一致使用。
- **仅返回 Markdown、移除纯文本**：响应更简洁，但破坏现有文本处理方式，并迫使消费者重复解析 Markdown。
- **为 URL 获取建立独立响应与 API**：可形成专用接口，但扩大调度与契约变更范围，当前需求可通过可选字段满足。
