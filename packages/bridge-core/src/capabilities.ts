/**
 * 渠道能力事实的**唯一真源**。
 *
 * 为什么它必须住在共享核心里：工具/命令描述是模型能看到的"能力可见性"的**唯一载体**，
 * 而两个宿主的描述必须各自携带自己的协议样板（VCP 有 `command` 字段纪律与 TOOL_REQUEST
 * 字段说明，DSH 有 JSON Schema 参数）。可共享的是**渠道事实**，不可共享的是协议样板。
 *
 * 若两侧各手写一份事实，漂移的表现是**静默的**：渠道实现了，但某个宿主的模型永远不知道
 * 它存在、也不知道该填什么。历史上已经栽过一次（见 ADR 与能力可见性的复盘），
 * 所以这里把事实抽成常量，并由两端的契约测试断言各自组装出的描述**逐字包含**本文件的文案。
 */

/** 搜索渠道全集（Provider 实例 id 口径，与 Gateway 的 sources 取值一致）。 */
export const SEARCH_CHANNELS = ["url-fetch", "x-search", "tavily", "exa", "anysearch"] as const;

/** API 型检索渠道：不依赖浏览器，自己就能返回正文。 */
export const API_CHANNELS = ["tavily", "exa", "anysearch"] as const;

/** 提供 extract 能力的渠道。 */
export const EXTRACT_CHANNELS = ["tavily", "exa", "anysearch"] as const;

/** 不提供 extract 的渠道。 */
export const NON_EXTRACT_CHANNELS = ["url-fetch", "x-search"] as const;

export interface ChannelFacts {
	querySemantics: "url" | "x-query" | "natural-language";
	returnsContent: boolean;
	supportsExtract: boolean;
	/** 单次 extract 能接受的 URL 数量上限（上游原生批次限制）。 */
	extractMaxUrls?: number;
	/** extract 能拿到的正文格式。exa 只有纯文本。 */
	extractContentFormat?: "markdown" | "text";
	/** 上游单次检索的结果条数上限（超出会被截断并在结果里标注）。 */
	upstreamResultCap?: number;
}

export const CHANNEL_FACTS: Readonly<Record<string, ChannelFacts>> = {
	"url-fetch": { querySemantics: "url", returnsContent: true, supportsExtract: false },
	"x-search": { querySemantics: "x-query", returnsContent: true, supportsExtract: false },
	tavily: {
		querySemantics: "natural-language",
		returnsContent: true,
		supportsExtract: true,
		extractMaxUrls: 20,
		extractContentFormat: "markdown",
	},
	exa: {
		querySemantics: "natural-language",
		returnsContent: true,
		supportsExtract: true,
		extractMaxUrls: 100,
		extractContentFormat: "text",
	},
	anysearch: {
		querySemantics: "natural-language",
		returnsContent: true,
		supportsExtract: true,
		extractMaxUrls: 1,
		extractContentFormat: "markdown",
		upstreamResultCap: 10,
	},
};

/**
 * 搜索侧的渠道事实文案。
 *
 * **不含任何协议样板**——`command` 字段纪律由 VCP 侧补，JSON Schema 说明由 DSH 侧补。
 * 两个宿主组装出的描述都必须**逐字包含**本常量。
 */
export const SEARCH_FACTS_TEXT = [
	"`query` 的语义随渠道变化，不要混用：",
	'  · `url-fetch`：`query` 直接写要抓取的 URL；',
	'  · `x-search`：`query` 写 X 原生检索式（如 "OpenAI" lang:en）；',
	"  · `tavily` / `exa` / `anysearch`：`query` 写自然语言检索式（如 Go 1.26 release notes），",
	"    这三家是 API 型检索渠道，适合「找资料」；`url-fetch` 适合「已知 URL 取正文」。",
	"  它们自己就能返回正文（tavily 可返回 Markdown、anysearch 可返回 Markdown、exa 为纯文本），",
	"  因此拿到这批渠道的结果后**不需要**再对同一批 URL 调一次 Extract。",
	"`sources` 可显式指定 Provider 实例（逗号分隔，例如 `tavily` 或 `tavily,exa`），",
	"`route` 可指定 Gateway 路由名（`tavily` / `exa` / `anysearch` 均有同名路由），二者都不填则走默认路由。",
	"API 渠道默认可能是停止状态；先确认 enabled 与可用操作再发起检索。",
	"`limit` 为期望条数（1-100，注意 anysearch 上游最多 10 条、会在结果里标注被截断），`language` 为语言偏好。",
].join("\n");

/**
 * 提取侧的渠道事实文案。
 *
 * 同样不含协议样板。**必须点名两件反直觉的事实**：anysearch 上游一次只接受 1 个 URL、
 * exa 只返回纯文本——不写明就会让人以为 markdown 一定能拿到、或者拿它去跑长列表。
 */
export const EXTRACT_FACTS_TEXT = [
	"只有 `tavily` / `exa` / `anysearch` 提供这一能力（`url-fetch` 与 `x-search` 没有，填了会失败）。",
	"三家的取舍：tavily 单次最多 20 个 URL、可给 Markdown；exa 单次最多 100 个 URL、正文**只有纯文本**；",
	"anysearch 上游**一次只接受 1 个 URL**（Aylens 会自动有界并发），URL 越多越慢，别拿它跑长列表。",
	"`limit` 为期望返回条数（1-100），`content` 控制正文格式（markdown 或 text）。",
].join("\n");
