import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AylensBridgeError, type AylensClient } from "../src/client.js";
import { loadConfig, parseEnvFile } from "../src/config.js";
import { dispatchCommand, normalizeParams } from "../src/dispatcher.js";

interface StubCall {
	method: "GET" | "POST";
	path: string;
	body?: unknown;
}

interface StubConfigOverrides {
	allowAuthLogin?: boolean;
}

function createStubClient(
	handler: (call: StubCall) => unknown,
	overrides: StubConfigOverrides = {},
): { client: AylensClient; calls: StubCall[] } {
	const calls: StubCall[] = [];
	const client = {
		config: {
			baseUrl: "http://127.0.0.1:3000",
			apiKey: "test-key",
			requestTimeoutMs: 1000,
			allowAuthLogin: overrides.allowAuthLogin ?? false,
		},
		get: (path: string) => {
			calls.push({ method: "GET", path });
			return Promise.resolve(handler({ method: "GET", path }));
		},
		post: (path: string, body?: unknown) => {
			calls.push(body === undefined ? { method: "POST", path } : { method: "POST", path, body });
			return Promise.resolve(handler(body === undefined ? { method: "POST", path } : { method: "POST", path, body }));
		},
	} as unknown as AylensClient;
	return { client, calls };
}

const searchDocument = {
	id: "doc-1",
	platform: "web",
	type: "page",
	url: "https://example.com",
	title: "Example Domain",
	snippet: "示例摘要",
	markdown: "# Example\n\n正文",
	retrievedAt: "2026-10-08T14:00:00.000Z",
	provenance: {
		provider: "url-fetch",
		retrievalMethod: "http",
		requestId: "req-1",
		fetchedAt: "2026-10-08T14:00:00.000Z",
		runtimeId: "runner-1",
	},
};

function textOf(response: { content?: Array<{ type: string; text?: string }> }): string {
	return (response.content ?? []).map((item) => item.text ?? "").join("\n");
}

describe("normalizeParams", () => {
	it("把扁平字段与嵌套 params 合并，并剥离 command / maid", () => {
		const params = normalizeParams({
			command: "Search",
			maid: "Nova",
			query: "flat",
			params: { limit: 3 },
		} as never);
		expect(params).toEqual({ query: "flat", limit: 3 });
	});
});

describe("dispatchCommand", () => {
	it("缺少 command 时抛出 INVALID_REQUEST", async () => {
		const { client } = createStubClient(() => ({}));
		await expect(dispatchCommand(client, {} as never)).rejects.toThrow(AylensBridgeError);
	});

	it("未知命令时抛出 INVALID_REQUEST 并列出可用命令", async () => {
		const { client } = createStubClient(() => ({}));
		await expect(dispatchCommand(client, { command: "Nope" })).rejects.toThrow(/可用命令/);
	});

	it("Search 缺少 query 时抛出 INVALID_REQUEST", async () => {
		const { client } = createStubClient(() => ({}));
		await expect(dispatchCommand(client, { command: "Search" })).rejects.toThrow(/query/);
	});

	it("Search 的 limit 越界时抛出 INVALID_REQUEST", async () => {
		const { client } = createStubClient(() => ({}));
		await expect(dispatchCommand(client, { command: "Search", query: "x", limit: 999 })).rejects.toThrow(
			/limit/,
		);
	});

	it("Search 只把已提供的字段放进请求体", async () => {
		const { client, calls } = createStubClient(() => ({
			requestId: "req-1",
			traceId: "trace-1",
			status: "completed",
			items: [searchDocument],
			meta: { providers: { "url-fetch": { status: "success", latencyMs: 12, resultCount: 1 } } },
		}));
		const response = await dispatchCommand(client, {
			command: "Search",
			query: "https://example.com",
			sources: "url-fetch,x",
			limit: "5",
		});
		expect(calls[0]?.path).toBe("/v1/search");
		expect(calls[0]?.body).toEqual({
			query: "https://example.com",
			sources: ["url-fetch", "x"],
			limit: 5,
		});
		expect(response.status).toBe("success");
		const text = textOf(response);
		expect(text).toContain("Example Domain");
		expect(text).toContain("正文");
	});

	it("Search 空结果是合法成功（不是错误）", async () => {
		const { client } = createStubClient(() => ({
			requestId: "req-2",
			traceId: "trace-2",
			status: "completed",
			items: [],
			meta: { providers: {} },
		}));
		const response = await dispatchCommand(client, { command: "Search", query: "nothing" });
		expect(response.status).toBe("success");
		expect(textOf(response)).toContain("合法空结果");
	});

	it("Search 整体失败且零命中时抛出 NO_RUNTIME 并带上 Provider 错误", async () => {
		const { client } = createStubClient(() => ({
			requestId: "req-3",
			traceId: "trace-3",
			status: "failed",
			items: [],
			meta: {
				providers: {
					"url-fetch": {
						status: "failed",
						latencyMs: 1,
						resultCount: 0,
						error: { code: "NO_RUNTIME", message: "无可用执行节点", retryable: true },
					},
				},
			},
		}));
		await expect(dispatchCommand(client, { command: "Search", query: "x" })).rejects.toThrow(
			/无可用执行节点/,
		);
	});

	it("GetStatus 同时探测 health 与 ready，并在无 Runner 时给出警示", async () => {
		const { client, calls } = createStubClient((call) =>
			call.path === "/health" ? { status: "ok" } : { status: "ready", runtimes: 0 },
		);
		const response = await dispatchCommand(client, { command: "GetStatus" });
		expect(calls.map((call) => call.path)).toEqual(["/health", "/ready"]);
		expect(textOf(response)).toContain("没有任何在线 Runner");
	});

	it("ListRuntimes 渲染节点能力，空列表时给出明确说明", async () => {
		const { client } = createStubClient(() => ({ runtimes: [] }));
		const empty = await dispatchCommand(client, { command: "ListRuntimes" });
		expect(textOf(empty)).toContain("没有任何 Runner");

		const { client: client2 } = createStubClient(() => ({
			runtimes: [
				{
					id: "runner-1",
					hostname: "syc",
					os: "windows",
					version: "0.1.0",
					protocolVersion: "1",
					status: "online",
					labels: { env: "prod" },
					capabilities: {
						providerTypes: ["url-fetch"],
						providerIds: ["url-fetch"],
						browsers: ["chrome"],
						profiles: ["browser-main"],
						proxyConfig: true,
						http: true,
						browserAutomation: true,
					},
					capacity: { maxJobs: 4, activeJobs: 1 },
					lastSeenAt: Date.now(),
				},
			],
		}));
		const text = textOf(await dispatchCommand(client2, { command: "ListRuntimes" }));
		expect(text).toContain("runner-1");
		expect(text).toContain("env=prod");
		expect(text).toContain("代理配置通道=true");
	});

	it("ListProviders 渲染 Provider 清单", async () => {
		const { client } = createStubClient(() => ({
			providers: [{ id: "url-fetch", type: "url-fetch", enabled: true, runtime: { mode: "any" } }],
		}));
		const text = textOf(await dispatchCommand(client, { command: "ListProviders" }));
		expect(text).toContain("url-fetch · type=url-fetch · enabled=true");
	});

	it("底层 fetch 失败被包装成 AylensBridgeError", async () => {
		const failingClient = {
			get: vi.fn().mockRejectedValue(new AylensBridgeError("GATEWAY_UNREACHABLE", "无法连接")),
			post: vi.fn().mockRejectedValue(new AylensBridgeError("GATEWAY_UNREACHABLE", "无法连接")),
		} as unknown as AylensClient;
		await expect(dispatchCommand(failingClient, { command: "GetStatus" })).rejects.toThrow(/无法连接/);
	});
});

describe("admin 与鉴权命令", () => {
	it("GetOverview 渲染总览，并把需要登录的 Provider 标成警示", async () => {
		const { client } = createStubClient(() => ({
			generatedAt: Date.now(),
			gateway: { status: "ready" },
			summary: {
				providers: 2,
				enabledProviders: 1,
				runtimes: 1,
				onlineRuntimes: 1,
				browserProfiles: 1,
				recentAudits: 1,
			},
			providers: [
				{ id: "url-fetch", type: "url-fetch", enabled: true },
				{
					id: "x",
					type: "x-search",
					enabled: true,
					authControl: true,
					auth: { status: "auth_required", checkedAt: Date.now() },
				},
			],
			runtimes: [{ id: "runner-1", status: "online", hostname: "syc" }],
			browserProfiles: [{ id: "browser-main", runtimeId: "runner-1", status: "available", activeLeases: 0, maxConcurrency: 1 }],
			audits: [
				{
					requestId: "req-1",
					traceId: "trace-1",
					request: { query: "https://example.com" },
					createdAt: Date.now(),
					status: "completed",
					providers: [],
				},
			],
		}));
		const text = textOf(await dispatchCommand(client, { command: "GetOverview" }));
		expect(text).toContain("Provider: 1/2 启用");
		expect(text).toContain("Runner: 1/1 在线");
		expect(text).toContain("x · type=x-search · enabled=true · 登录态=auth_required");
		expect(text).toContain("需要人工登录：x");
		expect(text).toContain("req-1 · completed");
	});

	it("GetOverview 在没有在线 Runner 时给出明确提示", async () => {
		const { client } = createStubClient(() => ({
			generatedAt: Date.now(),
			gateway: { status: "ready" },
			summary: { providers: 0, enabledProviders: 0, runtimes: 0, onlineRuntimes: 0, browserProfiles: 0, recentAudits: 0 },
			providers: [],
			runtimes: [],
			browserProfiles: [],
			audits: [],
		}));
		const text = textOf(await dispatchCommand(client, { command: "GetOverview" }));
		expect(text).toContain("没有在线 Runner");
	});

	it("GetAudit 缺少 requestId 时抛错，正常时展开 Provider 事件", async () => {
		const { client, calls } = createStubClient(() => ({
			requestId: "req-1",
			traceId: "trace-1",
			request: { query: "hello", sources: ["url-fetch"] },
			createdAt: Date.now() - 120,
			completedAt: Date.now(),
			status: "partial",
			providers: [
				{ providerId: "url-fetch", runtimeId: "runner-1", startedAt: 0, completedAt: 80, status: "success", resultCount: 3 },
				{ providerId: "x", startedAt: 0, completedAt: 40, status: "failed", errorCode: "AUTH_FAILED", resultCount: 0 },
			],
		}));
		await expect(dispatchCommand(client, { command: "GetAudit" })).rejects.toThrow(/requestId/);
		const text = textOf(await dispatchCommand(client, { command: "GetAudit", requestId: "req-1" }));
		expect(calls[0]?.path).toBe("/v1/audit/req-1");
		expect(text).toContain("status=partial");
		expect(text).toContain("url-fetch：success · 3 条");
		expect(text).toContain("x：failed · 0 条 · 40ms · AUTH_FAILED");
	});

	it("CheckProviderAuth 渲染登录态与账号", async () => {
		const { client, calls } = createStubClient(() => ({
			providerId: "x",
			runtimeId: "runner-1",
			auth: { status: "authenticated", account: { handle: "@nova" }, checkedAt: Date.now() },
		}));
		const text = textOf(await dispatchCommand(client, { command: "CheckProviderAuth", providerId: "x" }));
		expect(calls[0]?.path).toBe("/v1/providers/x/auth/check");
		expect(text).toContain("登录态=authenticated");
		expect(text).toContain("@nova");
	});

	it("LoginProviderAuth 默认拒绝（配置未开启）", async () => {
		const { client, calls } = createStubClient(() => ({}));
		await expect(
			dispatchCommand(client, { command: "LoginProviderAuth", providerId: "x", confirm: "x" }),
		).rejects.toThrow(/默认关闭/);
		expect(calls).toHaveLength(0);
	});

	it("LoginProviderAuth 开启后仍需 confirm 与 providerId 一致", async () => {
		const { client, calls } = createStubClient(() => ({}), { allowAuthLogin: true });
		await expect(
			dispatchCommand(client, { command: "LoginProviderAuth", providerId: "x", confirm: "y" }),
		).rejects.toThrow(/二次确认未通过/);
		expect(calls).toHaveLength(0);

		const { client: okClient, calls: okCalls } = createStubClient(
			() => ({ providerId: "x", runtimeId: "runner-1", auth: { status: "auth_required", checkedAt: Date.now() } }),
			{ allowAuthLogin: true },
		);
		const text = textOf(
			await dispatchCommand(okClient, { command: "LoginProviderAuth", providerId: "x", confirm: "x" }),
		);
		expect(okCalls[0]?.path).toBe("/v1/providers/x/auth/login");
		expect(text).toContain("上启动登录流程");
	});

	it("providerId 会做 URL 编码，避免路径注入", async () => {
		const { client, calls } = createStubClient(() => ({
			providerId: "a/b",
			runtimeId: "runner-1",
			auth: { status: "unknown", checkedAt: 0 },
		}));
		await dispatchCommand(client, { command: "CheckProviderAuth", providerId: "a/b" });
		expect(calls[0]?.path).toBe("/v1/providers/a%2Fb/auth/check");
	});
});

describe("parseEnvFile", () => {
	it("忽略注释与空行，剥离引号", () => {
		const parsed = parseEnvFile(
			["# comment", "", "AYLENS_BASE_URL=http://127.0.0.1:3000", 'AYLENS_API_KEY="dev-key"'].join("\n"),
		);
		expect(parsed).toEqual({
			AYLENS_BASE_URL: "http://127.0.0.1:3000",
			AYLENS_API_KEY: "dev-key",
		});
	});
});

describe("loadConfig", () => {
	function withSandbox(content: string | undefined, run: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "aylens-bridge-config-"));
		try {
			if (content !== undefined) writeFileSync(join(dir, "config.env"), content, "utf8");
			run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("从 config.env 读取并归一化 baseUrl（去尾斜杠）", () => {
		withSandbox(
			"AYLENS_BASE_URL=http://127.0.0.1:3999/\nAYLENS_API_KEY=k1\nREQUEST_TIMEOUT_MS=5000\n",
			(dir) => {
				const config = loadConfig(dir);
				expect(config.baseUrl).toBe("http://127.0.0.1:3999");
				expect(config.apiKey).toBe("k1");
				expect(config.requestTimeoutMs).toBe(5000);
				expect(config.allowAuthLogin).toBe(false);
			},
		);
	});

	it("config.env 缺失时回退环境变量（覆盖重装后的兜底路径）", () => {
		withSandbox(undefined, (dir) => {
			const previous = { ...process.env };
			process.env.AYLENS_BASE_URL = "http://127.0.0.1:4123";
			process.env.AYLENS_API_KEY = "env-key";
			try {
				expect(loadConfig(dir).apiKey).toBe("env-key");
			} finally {
				process.env = previous;
			}
		});
	});

	it("缺少 AYLENS_API_KEY 时抛 ConfigError", () => {
		withSandbox("AYLENS_BASE_URL=http://127.0.0.1:3000\n", (dir) => {
			const previousApiKey = process.env.AYLENS_API_KEY;
			process.env.AYLENS_API_KEY = "";
			try {
				expect(() => loadConfig(dir)).toThrow(/AYLENS_API_KEY/);
			} finally {
				if (previousApiKey === undefined) delete process.env.AYLENS_API_KEY;
				else process.env.AYLENS_API_KEY = previousApiKey;
			}
		});
	});

	it("AYLENS_ALLOW_AUTH_LOGIN 只认显式真值", () => {
		withSandbox("AYLENS_API_KEY=k1\nAYLENS_ALLOW_AUTH_LOGIN=true\n", (dir) => {
			expect(loadConfig(dir).allowAuthLogin).toBe(true);
		});
		withSandbox("AYLENS_API_KEY=k1\nAYLENS_ALLOW_AUTH_LOGIN=maybe\n", (dir) => {
			expect(loadConfig(dir).allowAuthLogin).toBe(false);
		});
	});

	it("非法 baseUrl 抛 ConfigError", () => {
		withSandbox("AYLENS_BASE_URL=ftp://example.com\nAYLENS_API_KEY=k1\n", (dir) => {
			expect(() => loadConfig(dir)).toThrow(/http\/https/);
		});
	});
});
