import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../../bridge-core/src/client.js";
import { EXTRACT_FACTS_TEXT, SEARCH_FACTS_TEXT } from "../../bridge-core/src/capabilities.js";
import { MAX_DOC_BODY_CHARS } from "../../bridge-core/src/render.js";
import { buildTools } from "../src/index.js";

const config: BridgeConfig = {
	baseUrl: "http://127.0.0.1:3000",
	apiKey: "dev-key",
	requestTimeoutMs: 1_000,
	allowAuthLogin: false,
};

type Definition = ReturnType<typeof buildTools>[number];
type Exec = Parameters<Definition["execute"]>[1];

function tool(name: string, overrides: Partial<BridgeConfig> = {}): Definition {
	const definition = buildTools({ ...config, ...overrides }).find((item) => item.name === name);
	if (definition === undefined) throw new Error(`工具 ${name} 未注册`);
	return definition;
}

/** 最小可用的执行上下文：插件只用到 exec.signal。 */
function exec(): Exec {
	return { signal: new AbortController().signal } as unknown as Exec;
}

function stubJson(payload: unknown, status = 200) {
	// 显式声明参数，否则 mock.calls 的元组长度是 0，测试里取 calls[0][0] 会报 TS2493。
	const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(payload), { status }));
	vi.stubGlobal("fetch", spy);
	return spy;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("工具集", () => {
	it("恰好注册 4 个工具，名字与顺序稳定", () => {
		expect(buildTools(config).map((item) => item.name)).toEqual([
			"aylens_search",
			"aylens_extract",
			"aylens_inspect",
			"aylens_login",
		]);
	});

	it("每个工具都有 output.schema、output.render 与 execute，且参数非空", () => {
		for (const definition of buildTools(config)) {
			expect(definition.output.schema, `${definition.name} 缺 output.schema`).toBeDefined();
			expect(typeof definition.output.render, `${definition.name} 缺 output.render`).toBe("function");
			expect(typeof definition.execute, `${definition.name} 缺 execute`).toBe("function");
			expect(Object.keys(definition.parameters).length).toBeGreaterThan(0);
		}
	});

	it("两个检索工具的描述逐字包含 core 的渠道事实文案", () => {
		expect(tool("aylens_search").description).toContain(SEARCH_FACTS_TEXT);
		expect(tool("aylens_extract").description).toContain(EXTRACT_FACTS_TEXT);
	});

	it("aylens_search 的描述写明相对内置检索的不可替代场景", () => {
		const description = tool("aylens_search").description;
		expect(description).toMatch(/web_search/);
		expect(description).toMatch(/登录态|登录/);
	});

	it("aylens_login 的描述写明强副作用", () => {
		const description = tool("aylens_login").description;
		expect(description).toMatch(/Chrome/);
		expect(description).toMatch(/打断|中断/);
		expect(description).toMatch(/不等待/);
	});

	it("缺 API Key 时调用报 CONFIG_ERROR 并指路 $DSH_HOME/.env，而不是激活期炸掉", async () => {
		const definition = tool("aylens_search", { apiKey: "" });
		await expect(
			definition.execute({ query: "x" } as never, exec()),
		).rejects.toThrow(/AYLENS_API_KEY/);
	});
});

describe("aylens_search", () => {
	const response = {
		requestId: "req-1",
		traceId: "trace-1",
		status: "completed",
		items: [
			{
				id: "d0",
				platform: "web",
				type: "page",
				url: "https://example.com",
				title: "甲",
				snippet: "摘要",
				publishedAt: "2026-10-01T00:00:00.000Z",
				retrievedAt: "2026-10-14T00:00:00.000Z",
				markdown: "正文",
				provenance: {
					provider: "tavily",
					retrievalMethod: "api",
					requestId: "req-1",
					fetchedAt: "2026-10-14T00:00:00.000Z",
				},
			},
		],
		meta: { providers: { tavily: { status: "success", latencyMs: 12, resultCount: 1 } } },
	};

	it("execute 只返回规范值：requestId / status / items / providers", async () => {
		stubJson(response);
		const value = (await tool("aylens_search").execute({ query: "q" } as never, exec())) as Record<string, unknown>;
		expect(value.requestId).toBe("req-1");
		expect(value.status).toBe("completed");
		expect(Array.isArray(value.items)).toBe(true);
		expect(value.providers).toEqual([{ id: "tavily", status: "success", latencyMs: 12, resultCount: 1 }]);
	});

	it("presentationMeta 投影出 WebSource 形状的 sources 与 truncated", async () => {
		const value = { requestId: "r", status: "completed", items: response.items, providers: [] };
		const meta = tool("aylens_search").output.presentationMeta?.({ query: "q" }, value as never) as {
			sources: Array<Record<string, unknown>>;
			truncated: boolean;
		};
		expect(meta.truncated).toBe(false);
		expect(meta.sources[0]).toEqual({
			url: "https://example.com",
			title: "甲",
			snippet: "摘要",
			publishedAt: "2026-10-01T00:00:00.000Z",
		});
	});

	it("presentResult 从 meta 读回 web/search 卡", () => {
		const view = tool("aylens_search").presentResult?.({ query: "q" } as never, {
			content: [],
			isError: false,
			meta: { sources: [{ url: "https://example.com" }], truncated: true },
		} as never);
		expect(view).toEqual({
			card: "web",
			kind: "search",
			title: "Aylens 检索：q",
			sources: [{ url: "https://example.com" }],
			truncated: true,
		});
	});
});

describe("aylens_extract", () => {
	const response = {
		requestId: "req-2",
		traceId: "trace-2",
		status: "completed",
		items: [{ index: 0, url: "https://example.com", status: "success", document: { markdown: "正文" } }],
		meta: { providers: { tavily: { status: "success" } } },
	};

	it("单 URL 呈现成 web/fetch 卡，多 URL 退回 generic", () => {
		const definition = tool("aylens_extract");
		// 注意：defineTool 会给 presentResult 套一道软校验门——args 校验不通过时直接返回 undefined，
		// 所以这里必须传齐必填的 urls 与 sources。
		const single = definition.presentResult?.(
			{ urls: ["https://example.com"], sources: ["tavily"] } as never,
			{
				content: [],
				isError: false,
				meta: { kind: "fetch", url: "https://example.com", statusCode: 200, truncated: false },
			} as never,
		);
		expect(single).toMatchObject({ card: "web", kind: "fetch", url: "https://example.com" });

		const many = definition.presentResult?.(
			{ urls: ["https://a", "https://b"], sources: ["tavily"] } as never,
			{ content: [], isError: false, meta: { kind: "list" } } as never,
		);
		expect(many).toMatchObject({ card: "generic" });
	});

	it("presentResult 在 args 不合法时返回 undefined（defineTool 的软校验门）", () => {
		const view = tool("aylens_extract").presentResult?.({ urls: ["https://a"] } as never, {
			content: [],
			isError: false,
			meta: { kind: "list" },
		} as never);
		expect(view).toBeUndefined();
	});

	it("execute 返回逐项结果与成败计数", async () => {
		stubJson(response);
		const value = (await tool("aylens_extract").execute(
			{ urls: ["https://example.com"], sources: ["tavily"] } as never,
			exec(),
		)) as Record<string, unknown>;
		expect(value.succeeded).toBe(1);
		expect(value.failed).toBe(0);
	});
});

describe("aylens_inspect", () => {
	it("scope=provider-auth 缺 providerId 时给出指路错误", async () => {
		await expect(
			tool("aylens_inspect").execute({ scope: "provider-auth" } as never, exec()),
		).rejects.toThrow(/providerId/);
	});

	it("scope=audit 缺 requestId 时给出指路错误", async () => {
		await expect(tool("aylens_inspect").execute({ scope: "audit" } as never, exec())).rejects.toThrow(
			/requestId/,
		);
	});

	it("scope=runtimes 打到 /v1/runtimes 并把渲染文本放进 text", async () => {
		const spy = stubJson({ runtimes: [] });
		const value = (await tool("aylens_inspect").execute({ scope: "runtimes" } as never, exec())) as {
			scope: string;
			text: string;
		};
		expect(String(spy.mock.calls[0]?.[0])).toContain("/v1/runtimes");
		expect(value.scope).toBe("runtimes");
		expect(value.text).toContain("没有任何 Runner");
	});

	it("scope=gateway 同时探测 /health 与 /ready", async () => {
		const spy = vi.fn(async (url: string) =>
			String(url).endsWith("/health")
				? new Response(JSON.stringify({ status: "ok" }), { status: 200 })
				: new Response(JSON.stringify({ status: "ready", runtimes: 1 }), { status: 200 }),
		);
		vi.stubGlobal("fetch", spy);
		const value = (await tool("aylens_inspect").execute({ scope: "gateway" } as never, exec())) as {
			text: string;
		};
		const urls = spy.mock.calls.map((call) => String(call[0]));
		expect(urls.some((u) => u.endsWith("/health"))).toBe(true);
		expect(urls.some((u) => u.endsWith("/ready"))).toBe(true);
		expect(value.text).toContain("在线 Runner=1");
	});

	it("scope=providers 同时取 providers 与 runtimes（能力事实来自 Runner 心跳）", async () => {
		const spy = vi.fn(async (url: string) =>
			String(url).includes("/v1/providers")
				? new Response(JSON.stringify({ providers: [{ id: "tavily", type: "tavily", enabled: true, runtime: null }] }), { status: 200 })
				: new Response(JSON.stringify({ runtimes: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", spy);
		const value = (await tool("aylens_inspect").execute({ scope: "providers" } as never, exec())) as {
			text: string;
		};
		expect(value.text).toContain("tavily");
		expect(value.text).toContain("未知（当前没有在线 Runner）");
	});
});

describe("aylens_login 的闸门", () => {
	it("未开启 allowAuthLogin 时拒绝，并说明怎么开", async () => {
		await expect(
			tool("aylens_login").execute({ providerId: "x", confirm: "x" } as never, exec()),
		).rejects.toThrow(/allowAuthLogin/);
	});

	it("confirm 与 providerId 不等时拒绝", async () => {
		await expect(
			tool("aylens_login", { allowAuthLogin: true }).execute({ providerId: "x", confirm: "y" } as never, exec()),
		).rejects.toThrow(/confirm/);
	});

	it("两道闸门都过时打到 /auth/login 并返回 launched=true", async () => {
		const spy = stubJson({
			providerId: "x",
			runtimeId: "runner-1",
			auth: { status: "auth_required", checkedAt: Date.now() },
		});
		const value = (await tool("aylens_login", { allowAuthLogin: true }).execute(
			{ providerId: "x", confirm: "x" } as never,
			exec(),
		)) as Record<string, unknown>;
		expect(String(spy.mock.calls[0]?.[0])).toContain("/v1/providers/x/auth/login");
		expect(value.launched).toBe(true);
		expect(value.runtimeId).toBe("runner-1");
	});
});

describe("截断与成功状态的如实上报", () => {
	// 这两条针对的是「静默谎报」：卡片说没截断、其实是砍过的；或提取失败却盖 HTTP 200 的章。

	it("aylens_search 的 truncated 反映真实截断（超预算时为 true）", () => {
		const definition = tool("aylens_search");
		const longBody = "x".repeat(MAX_DOC_BODY_CHARS + 500);
		const meta = definition.output.presentationMeta?.({ query: "q" } as never, {
			requestId: "r",
			status: "completed",
			providers: [],
			items: [{ url: "https://example.com", markdown: longBody }],
		} as never) as { truncated: boolean };
		expect(meta.truncated).toBe(true);
	});

	it("aylens_search 的 truncated 在正文装得下时为 false", () => {
		const definition = tool("aylens_search");
		const meta = definition.output.presentationMeta?.({ query: "q" } as never, {
			requestId: "r",
			status: "completed",
			providers: [],
			items: [{ url: "https://example.com", markdown: "短正文" }],
		} as never) as { truncated: boolean };
		expect(meta.truncated).toBe(false);
	});

	it("aylens_extract 的单 URL 只有**真的成功**才给 web/fetch 卡", () => {
		const definition = tool("aylens_extract");
		const succeeded = definition.output.presentationMeta?.(
			{ urls: ["https://a.example"], sources: ["tavily"] } as never,
			{
				requestId: "r",
				status: "completed",
				succeeded: 1,
				failed: 0,
				items: [{ index: 0, url: "https://a.example", status: "success", document: { text: "正文" } }],
			} as never,
		) as { kind: string; url?: string };
		expect(succeeded.kind).toBe("fetch");
		expect(succeeded.url).toBe("https://a.example");
	});

	it("aylens_extract 的单 URL 提取失败时退回通用卡，不谎报 HTTP 200", () => {
		// ADR retrieval-capability-contracts：不能仅凭 HTTP 200 判定所有项成功。
		const definition = tool("aylens_extract");
		const failed = definition.output.presentationMeta?.(
			{ urls: ["https://a.example"], sources: ["tavily"] } as never,
			{
				requestId: "r",
				status: "failed",
				succeeded: 0,
				failed: 1,
				items: [
					{
						index: 0,
						url: "https://a.example",
						status: "failed",
						error: { code: "CONTENT_UNAVAILABLE", message: "上游原文", retryable: false },
					},
				],
			} as never,
		) as { kind: string };
		expect(failed.kind).toBe("list");
	});
});

describe("取消传播", () => {
	it("调用方 abort 会让工具以 ABORTED 失败，而不是伪装成超时", async () => {
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			await new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
			throw new Error("unreachable");
		});
		const controller = new AbortController();
		const pending = tool("aylens_inspect").execute({ scope: "runtimes" } as never, {
			signal: controller.signal,
		} as unknown as Exec);
		controller.abort(new DOMException("cancelled", "AbortError"));
		await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
	});
});
