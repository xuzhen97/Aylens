import { describe, expect, it } from "vitest";
import {
	API_CHANNELS,
	CHANNEL_FACTS,
	EXTRACT_CHANNELS,
	EXTRACT_FACTS_TEXT,
	NON_EXTRACT_CHANNELS,
	SEARCH_CHANNELS,
	SEARCH_FACTS_TEXT,
} from "../src/capabilities.js";

describe("渠道事实", () => {
	it("渠道全集包含两家浏览器型与三家 API 型检索渠道", () => {
		expect([...SEARCH_CHANNELS]).toEqual(["url-fetch", "x-search", "tavily", "exa", "anysearch"]);
		for (const id of SEARCH_CHANNELS) {
			expect(CHANNEL_FACTS[id], `缺少 ${id} 的事实`).toBeDefined();
		}
	});

	it("三家 API 渠道都声明支持 extract 并各自带上真实批量与格式事实", () => {
		expect([...API_CHANNELS].sort()).toEqual(["anysearch", "exa", "tavily"]);

		expect(CHANNEL_FACTS.tavily?.supportsExtract).toBe(true);
		expect(CHANNEL_FACTS.tavily?.extractMaxUrls).toBe(20);
		expect(CHANNEL_FACTS.tavily?.extractContentFormat).toBe("markdown");

		expect(CHANNEL_FACTS.exa?.supportsExtract).toBe(true);
		expect(CHANNEL_FACTS.exa?.extractMaxUrls).toBe(100);
		expect(CHANNEL_FACTS.exa?.extractContentFormat).toBe("text");

		expect(CHANNEL_FACTS.anysearch?.supportsExtract).toBe(true);
		expect(CHANNEL_FACTS.anysearch?.extractMaxUrls).toBe(1);
		expect(CHANNEL_FACTS.anysearch?.upstreamResultCap).toBe(10);
	});

	it("url-fetch 与 x-search 不提供 extract", () => {
		expect([...NON_EXTRACT_CHANNELS]).toEqual(["url-fetch", "x-search"]);
		expect(CHANNEL_FACTS["url-fetch"]?.supportsExtract).toBe(false);
		expect(CHANNEL_FACTS["x-search"]?.supportsExtract).toBe(false);
	});

	it("API 渠道自带正文，三类渠道的 query 语义各不相同", () => {
		expect(CHANNEL_FACTS["url-fetch"]?.querySemantics).toBe("url");
		expect(CHANNEL_FACTS["x-search"]?.querySemantics).toBe("x-query");
		for (const id of API_CHANNELS) {
			expect(CHANNEL_FACTS[id]?.querySemantics).toBe("natural-language");
			expect(CHANNEL_FACTS[id]?.returnsContent).toBe(true);
		}
	});

	it("extract 渠道集合与「支持 extract」的标志一致", () => {
		const declared = SEARCH_CHANNELS.filter((id) => CHANNEL_FACTS[id]?.supportsExtract === true);
		expect([...EXTRACT_CHANNELS].sort()).toEqual([...declared].sort());
	});
});

describe("渠道事实文案（两宿主共用的唯一真源）", () => {
	it("搜索侧文案点名全部渠道与三类 query 语义", () => {
		for (const id of ["url-fetch", "x-search", ...API_CHANNELS]) {
			expect(SEARCH_FACTS_TEXT, `搜索侧文案漏掉 ${id}`).toContain(id);
		}
		// API 渠道自带正文这条必须写明，否则调用方会对同一批 URL 再发一次 Extract。
		expect(SEARCH_FACTS_TEXT).toContain("不需要");
		// anysearch 上游截断这条最反直觉，必须写进描述。
		expect(SEARCH_FACTS_TEXT).toContain("10 条");
	});

	it("提取侧文案点名三家可用来源、两家不可用来源，以及各家的真实限制", () => {
		for (const id of EXTRACT_CHANNELS) expect(EXTRACT_FACTS_TEXT).toContain(id);
		for (const id of NON_EXTRACT_CHANNELS) expect(EXTRACT_FACTS_TEXT).toContain(id);
		// anysearch 上游一次只接受一个 URL。
		expect(EXTRACT_FACTS_TEXT).toContain("1 个 URL");
		// exa 只有纯文本；不写明会让人以为 markdown 一定能拿到。
		expect(EXTRACT_FACTS_TEXT).toContain("纯文本");
		expect(EXTRACT_FACTS_TEXT).toContain("20");
		expect(EXTRACT_FACTS_TEXT).toContain("100");
	});

	it("两段文案都不含任何宿主专属的协议样板", () => {
		// 事实只写一遍，样板各写各的：VCP 有 command 字段纪律、DSH 有 JSON Schema。
		for (const text of [SEARCH_FACTS_TEXT, EXTRACT_FACTS_TEXT]) {
			expect(text).not.toContain("TOOL_REQUEST");
			expect(text).not.toContain("「始」");
			expect(text).not.toContain("command");
		}
	});
});
