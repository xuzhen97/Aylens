import { afterEach, describe, expect, it, vi } from "vitest";
import { AylensBridgeError, AylensClient, type BridgeConfig } from "../src/client.js";
import {
	checkProviderAuth,
	extract,
	getAudit,
	getStatus,
	listProviders,
	listRuntimes,
	loginProviderAuth,
	search,
} from "../src/operations.js";

const config: BridgeConfig = {
	baseUrl: "http://127.0.0.1:3000",
	apiKey: "dev-key",
	requestTimeoutMs: 1_000,
	allowAuthLogin: false,
};

function client(overrides: Partial<BridgeConfig> = {}): AylensClient {
	return new AylensClient({ ...config, ...overrides });
}

/** 打桩 fetch 并返回 spy，便于断言请求体与路径。 */
function stubJson(payload: unknown, status = 200) {
	const spy = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
	vi.stubGlobal("fetch", spy);
	return spy;
}

function lastBody(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
	const call = spy.mock.calls.at(-1);
	const init = call?.[1] as RequestInit | undefined;
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function lastUrl(spy: { mock: { calls: unknown[][] } }): string {
	return String(spy.mock.calls.at(-1)?.[0]);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("search", () => {
	it("limit 超出 1..100 时抛 INVALID_REQUEST，且不发请求", async () => {
		const spy = stubJson({});
		await expect(search(client(), { query: "x", limit: 0 })).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		await expect(search(client(), { query: "x", limit: 101 })).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		expect(spy).not.toHaveBeenCalled();
	});

	it("整体失败且零命中时抛 NO_RUNTIME，并把每个 Provider 的错误拼进消息", async () => {
		stubJson({
			requestId: "req-1",
			traceId: "trace-1",
			status: "failed",
			items: [],
			meta: {
				providers: {
					tavily: {
						status: "failed",
						latencyMs: 5,
						resultCount: 0,
						error: { code: "NO_COMPATIBLE_RUNTIME", message: "no runner", retryable: false },
					},
				},
			},
		});
		const error = await search(client(), { query: "x" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AylensBridgeError);
		expect((error as AylensBridgeError).code).toBe("NO_RUNTIME");
		expect((error as AylensBridgeError).message).toContain("NO_COMPATIBLE_RUNTIME");
	});

	it("合法的空结果不抛错（Provider 执行了但没命中）", async () => {
		stubJson({
			requestId: "req-2",
			traceId: "t",
			status: "completed",
			items: [],
			meta: { providers: {} },
		});
		await expect(search(client(), { query: "x" })).resolves.toMatchObject({ items: [] });
	});

	it("只把显式给出的可选字段放进请求体", async () => {
		const spy = stubJson({
			requestId: "r",
			traceId: "t",
			status: "completed",
			items: [],
			meta: { providers: {} },
		});
		await search(client(), { query: "x", sources: ["tavily"], limit: 5 });
		expect(lastBody(spy)).toEqual({ query: "x", sources: ["tavily"], limit: 5 });
	});
});

describe("extract", () => {
	it("content=markdown 时请求体装配成 content.format", async () => {
		const spy = stubJson({
			requestId: "r",
			traceId: "t",
			status: "completed",
			items: [{ index: 0, url: "https://example.com", status: "success", document: { markdown: "hi" } }],
			meta: { providers: {} },
		});
		await extract(client(), {
			urls: ["https://example.com"],
			sources: ["tavily"],
			content: "markdown",
		});
		expect(lastBody(spy).content).toEqual({ format: "markdown" });
	});

	it("未给 content 时请求体里没有 content 字段", async () => {
		const spy = stubJson({
			requestId: "r",
			traceId: "t",
			status: "completed",
			items: [{ index: 0, url: "https://example.com", status: "success", document: { text: "hi" } }],
			meta: { providers: {} },
		});
		await extract(client(), { urls: ["https://example.com"], sources: ["tavily"] });
		expect("content" in lastBody(spy)).toBe(false);
	});

	it("缺 sources 时抛 INVALID_REQUEST（提取不复用搜索的默认路由）", async () => {
		const spy = stubJson({});
		await expect(
			extract(client(), { urls: ["https://example.com"], sources: [] }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("缺 urls 时抛 INVALID_REQUEST", async () => {
		stubJson({});
		await expect(extract(client(), { urls: [], sources: ["tavily"] })).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
	});

	it("全部条目失败时抛 NO_RUNTIME", async () => {
		stubJson({
			requestId: "r",
			traceId: "t",
			status: "failed",
			items: [
				{
					index: 0,
					url: "https://example.com",
					status: "failed",
					error: { code: "CONTENT_UNAVAILABLE", message: "nope", retryable: false },
				},
			],
			meta: { providers: { tavily: { status: "failed", error: { code: "CONTENT_UNAVAILABLE" } } } },
		});
		await expect(
			extract(client(), { urls: ["https://example.com"], sources: ["tavily"] }),
		).rejects.toMatchObject({ code: "NO_RUNTIME" });
	});

	it("部分成功不抛错，原样返回逐项结果", async () => {
		stubJson({
			requestId: "r",
			traceId: "t",
			status: "partial",
			items: [
				{ index: 0, url: "https://a.example", status: "success", document: { text: "A" } },
				{
					index: 1,
					url: "https://b.example",
					status: "failed",
					error: { code: "CONTENT_UNAVAILABLE", message: "x", retryable: false },
				},
			],
			meta: { providers: {} },
		});
		const response = await extract(client(), {
			urls: ["https://a.example", "https://b.example"],
			sources: ["tavily"],
		});
		expect(response.items).toHaveLength(2);
		expect(response.status).toBe("partial");
	});
});

describe("诊断类取值", () => {
	it("getStatus 同时打 /health 与 /ready", async () => {
		const spy = vi.fn(async (url: string) => {
			const text = String(url);
			if (text.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
			return new Response(JSON.stringify({ status: "ready", runtimes: 2 }), { status: 200 });
		});
		vi.stubGlobal("fetch", spy);
		const result = await getStatus(client());
		expect(result.health.status).toBe("ok");
		expect(result.ready.runtimes).toBe(2);
		const urls = spy.mock.calls.map((call) => String(call[0]));
		expect(urls.some((u) => u.endsWith("/health"))).toBe(true);
		expect(urls.some((u) => u.endsWith("/ready"))).toBe(true);
	});

	it("listRuntimes 打 /v1/runtimes", async () => {
		const spy = stubJson({ runtimes: [] });
		await listRuntimes(client());
		expect(lastUrl(spy)).toContain("/v1/runtimes");
	});

	it("listProviders 合并 /v1/providers 与 /v1/runtimes（能力事实来自 Runner 心跳）", async () => {
		const spy = vi.fn(async (url: string) => {
			const text = String(url);
			if (text.includes("/v1/providers")) {
				return new Response(JSON.stringify({ providers: [{ id: "tavily", type: "tavily", enabled: true, runtime: null }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ runtimes: [] }), { status: 200 });
		});
		vi.stubGlobal("fetch", spy);
		const result = await listProviders(client());
		expect(result.providers).toHaveLength(1);
		expect(result.runtimes).toEqual([]);
	});

	it("checkProviderAuth 打 /v1/providers/:id/auth/check 并 URL 编码 id", async () => {
		const spy = stubJson({ providerId: "x y", runtimeId: "r1", auth: { status: "authenticated", checkedAt: 1 } });
		await checkProviderAuth(client(), { providerId: "x y" });
		expect(lastUrl(spy)).toContain("/v1/providers/x%20y/auth/check");
	});

	it("getAudit 打 /v1/audit/:requestId 并 URL 编码", async () => {
		const spy = stubJson({ requestId: "req 1", traceId: "t", request: { query: "q" }, createdAt: 1, status: "completed", providers: [] });
		await getAudit(client(), { requestId: "req 1" });
		expect(lastUrl(spy)).toContain("/v1/audit/req%201");
	});
});

describe("loginProviderAuth 的两道闸门", () => {
	it("allowAuthLogin=false 时抛 AUTH_LOGIN_DISABLED 且不发请求", async () => {
		const spy = stubJson({});
		await expect(
			loginProviderAuth(client(), { providerId: "x", confirm: "x" }),
		).rejects.toMatchObject({ code: "AUTH_LOGIN_DISABLED" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("confirm 与 providerId 不同时抛 AUTH_LOGIN_DISABLED 且不发请求", async () => {
		const spy = stubJson({});
		await expect(
			loginProviderAuth(client({ allowAuthLogin: true }), { providerId: "x", confirm: "y" }),
		).rejects.toMatchObject({ code: "AUTH_LOGIN_DISABLED" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("两道闸门都过时打 /auth/login", async () => {
		const spy = stubJson({ providerId: "x", runtimeId: "r1", auth: { status: "auth_required", checkedAt: 1 } });
		const response = await loginProviderAuth(client({ allowAuthLogin: true }), {
			providerId: "x",
			confirm: "x",
		});
		expect(lastUrl(spy)).toContain("/v1/providers/x/auth/login");
		expect(response.runtimeId).toBe("r1");
	});
});
