import { describe, expect, it } from "vitest";
import type { ExtractResponse, ProvidersResponse, RuntimeRecord, SearchResponse } from "../src/contracts.js";
import {
	MAX_DOC_BODY_CHARS,
	MAX_TOTAL_BODY_CHARS,
	formatAge,
	isExtractBodyTruncated,
	isSearchBodyTruncated,
	renderExtractResponse,
	renderProviders,
	renderSearchResponse,
	renderStatus,
} from "../src/render.js";

function doc(index: number, body: string) {
	return {
		id: `d${index}`,
		platform: "web",
		type: "page",
		url: `https://example.com/${index}`,
		retrievedAt: "2026-10-14T00:00:00.000Z",
		markdown: body,
		provenance: {
			provider: "tavily",
			retrievalMethod: "api",
			requestId: "req-1",
			fetchedAt: "2026-10-14T00:00:00.000Z",
		},
	};
}

function searchResponse(body: string, count = 1): SearchResponse {
	return {
		requestId: "req-1",
		traceId: "t",
		status: "completed",
		items: Array.from({ length: count }, (_v, index) => doc(index, body)),
		meta: { providers: { tavily: { status: "success", latencyMs: 12, resultCount: count } } },
	};
}

describe("renderSearchResponse", () => {
	it("单篇正文超出预算时截断并显式标注", () => {
		const text = renderSearchResponse(searchResponse("x".repeat(MAX_DOC_BODY_CHARS + 500)));
		expect(text).toContain("正文已截断");
		expect(text.length).toBeLessThan(MAX_DOC_BODY_CHARS + 2_000);
	});

	it("多篇正文总量受 MAX_TOTAL_BODY_CHARS 约束，超限部分显式省略", () => {
		const text = renderSearchResponse(searchResponse("y".repeat(MAX_DOC_BODY_CHARS), 20));
		expect(text).toContain("正文总量已达上限");
	});

	it("全部 Provider 失败且零命中时，保留「不要把它当成查无结果」的护栏文案", () => {
		const response = searchResponse("", 0);
		response.status = "failed";
		response.meta.providers = {
			tavily: {
				status: "failed",
				latencyMs: 3,
				resultCount: 0,
				error: { code: "NO_COMPATIBLE_RUNTIME", message: "no runner", retryable: false },
			},
		};
		const text = renderSearchResponse(response);
		expect(text).toContain("不要把它当成「查无结果」");
		expect(text).toContain("NO_COMPATIBLE_RUNTIME");
	});

	it("合法的空结果明确说明是空结果而不是失败", () => {
		// 空结果 + 没有任何失败的 Provider = Provider 已执行但没命中
		const text = renderSearchResponse(searchResponse("", 0));
		expect(text).toContain("合法空结果");
	});

	it("渲染标题、URL、来源与 requestId", () => {
		const response = searchResponse("正文", 1);
		response.items[0] = { ...(response.items[0] as ReturnType<typeof doc>), title: "标题甲" };
		const text = renderSearchResponse(response);
		expect(text).toContain("标题甲");
		expect(text).toContain("https://example.com/0");
		expect(text).toContain("requestId=req-1");
	});
});

describe("renderExtractResponse", () => {
	it("逐条渲染成功项与失败项，失败只回错误码不透传上游文案", () => {
		const response: ExtractResponse = {
			requestId: "r",
			traceId: "t",
			status: "partial",
			items: [
				{ index: 0, url: "https://a.example", status: "success", document: { title: "甲", markdown: "正文甲" } },
				{
					index: 1,
					url: "https://b.example",
					status: "failed",
					error: { code: "CONTENT_UNAVAILABLE", message: "上游原始错误不该出现", retryable: false },
				},
			],
			meta: { providers: { tavily: { status: "partial" } } },
		};
		const text = renderExtractResponse(response);
		expect(text).toContain("成功 1 / 失败 1");
		expect(text).toContain("正文甲");
		expect(text).toContain("CONTENT_UNAVAILABLE");
		expect(text).not.toContain("上游原始错误不该出现");
	});

	it("单条正文超限时截断并标注", () => {
		const response: ExtractResponse = {
			requestId: "r",
			traceId: "t",
			status: "completed",
			items: [
				{ index: 0, url: "https://a.example", status: "success", document: { text: "z".repeat(MAX_DOC_BODY_CHARS + 100) } },
			],
			meta: { providers: {} },
		};
		expect(renderExtractResponse(response)).toContain("已截断");
	});
});

function runtime(overrides: Partial<RuntimeRecord>): RuntimeRecord {
	return {
		id: "runner-1",
		hostname: "host",
		os: "win32",
		version: "1.0.0",
		protocolVersion: "1",
		status: "online",
		labels: {},
		capabilities: {
			providerTypes: ["tavily"],
			providerIds: ["tavily"],
			browsers: [],
			profiles: [],
			http: true,
			browserAutomation: false,
		},
		capacity: { maxJobs: 4, activeJobs: 1 },
		lastSeenAt: Date.now(),
		...overrides,
	};
}

describe("renderProviders", () => {
	const providers: ProvidersResponse["providers"] = [
		{ id: "tavily", type: "tavily", enabled: true, runtime: null },
		{ id: "x", type: "x-search", enabled: true, runtime: null },
	];

	it("有在线 Runner 上报能力时逐条列出可用操作", () => {
		const text = renderProviders({
			providers,
			runtimes: [runtime({ capabilities: { ...runtime({}).capabilities, providerOperations: { tavily: ["search", "extract"] } } })],
		});
		expect(text).toContain("search,extract@runner-1");
	});

	it("在线 Runner 没有声明该 Provider 时显示「未上报」，而不是谎报支持", () => {
		const text = renderProviders({ providers, runtimes: [runtime({})] });
		expect(text).toContain("未上报（在线 Runner 没有声明这个 Provider）");
	});

	it("没有在线 Runner 时显示「未知」并给出无执行节点的告警", () => {
		const text = renderProviders({
			providers,
			runtimes: [runtime({ status: "offline" })],
		});
		expect(text).toContain("未知（当前没有在线 Runner）");
		expect(text).toContain("无可用执行节点");
	});

	it("旧 Runner 未上报能力时给出明确 caveat 而不合并成假共识", () => {
		const text = renderProviders({ providers, runtimes: [runtime({})] });
		expect(text).toContain("未上报 Provider 能力");
	});
});

describe("renderStatus", () => {
	it("没有在线 Runner 时说明 /v1/search 会报无可用执行节点且没有本地回退", () => {
		const text = renderStatus({ health: { status: "ok" }, ready: { status: "ready", runtimes: 0 } });
		expect(text).toContain("没有任何在线 Runner");
		expect(text).toContain("无可用执行节点");
	});

	it("有在线 Runner 时正常汇报", () => {
		const text = renderStatus({ health: { status: "ok" }, ready: { status: "ready", runtimes: 2 } });
		expect(text).toContain("在线 Runner=2");
		expect(text).not.toContain("没有任何在线 Runner");
	});
});

describe("截断判定的如实上报", () => {
	// 这两条的意义：宿主（DSH）要向上层如实上报 truncated。若让它自己推算一遍预算，
	// 就会与渲染器漂移，表现为「正文砍掉一半、卡片却标未截断」。因此判定与使用必须同源，
	// 并由「判定结果 === 渲染输出里是否出现截断标注」这条等式钉住。
	it("isSearchBodyTruncated 与 renderSearchResponse 的截断标注逐例一致", () => {
		const cases = [
			searchResponse("x".repeat(MAX_DOC_BODY_CHARS + 500), 1),
			searchResponse("y".repeat(MAX_DOC_BODY_CHARS), 20),
			searchResponse("短正文", 3),
			searchResponse("", 5),
		];
		for (const [index, response] of cases.entries()) {
			const rendered = renderSearchResponse(response);
			const marked =
				rendered.includes("正文已截断") || rendered.includes("正文总量已达上限");
			expect(isSearchBodyTruncated(response.items), `case ${index}`).toBe(marked);
		}
	});

	it("isExtractBodyTruncated 与 renderExtractResponse 的截断标注逐例一致", () => {
		const make = (body: string): ExtractResponse => ({
			requestId: "r",
			traceId: "t",
			status: "completed",
			items: [{ index: 0, url: "https://a.example", status: "success", document: { text: body } }],
			meta: { providers: {} },
		});
		const cases = [
			make("z".repeat(MAX_DOC_BODY_CHARS + 1)),
			make("z".repeat(MAX_DOC_BODY_CHARS)),
			make("短正文"),
		];
		for (const [index, response] of cases.entries()) {
			const rendered = renderExtractResponse(response);
			const bodies = response.items.map((item) => item.document ?? {});
			expect(isExtractBodyTruncated(bodies), `case ${index}`).toBe(rendered.includes("已截断"));
		}
	});

	it("Extract 没有总量上限，所以它与 Search 的判定口径必须不同", () => {
		// 10 篇各 4000 字符：Search 会因总量上限截断，Extract 不会。
		const bodies = Array.from({ length: 10 }, () => ({ text: "z".repeat(MAX_DOC_BODY_CHARS) }));
		expect(isSearchBodyTruncated(bodies)).toBe(true);
		expect(isExtractBodyTruncated(bodies)).toBe(false);
	});
});

describe("formatAge", () => {
	it("按秒/分/小时分档渲染相对时间", () => {
		const now = Date.now();
		expect(formatAge(now - 5_000)).toContain("s 前");
		expect(formatAge(now - 5 * 60_000)).toContain("m 前");
		expect(formatAge(now - 5 * 3_600_000)).toContain("h 前");
	});

	it("非有限值返回「未知」，未来时间返回「刚刚」", () => {
		expect(formatAge(Number.NaN)).toBe("未知");
		expect(formatAge(Date.now() + 60_000)).toBe("刚刚");
	});
});
