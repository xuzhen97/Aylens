#!/usr/bin/env node
/**
 * AylensBridge stdio 契约冒烟测试。
 *
 * 不依赖 VCPToolBox，只模拟它对同步插件做的事：
 *   cwd = 插件目录、stdin 写一个 JSON、等进程退出、JSON.parse(stdout.trim())。
 * 目标是把"实现没坏"和"契约没坏"分开验证——后者才是插件在真实链路里翻车的地方。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginEntry = resolve(packageDir, "..", "..", "plugins", "aylens", "index.cjs");
const API_KEY = "smoke-key";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ""}\n`);
	} else {
		failures.push(name);
		process.stdout.write(`  FAIL  ${name}  ${detail}\n`);
	}
}

function startStubGateway() {
	const server = createServer((req, res) => {
		const send = (status, payload) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
		};
		if (req.headers.authorization !== `Bearer ${API_KEY}`) {
			return send(401, { error: { code: "AUTH_FAILED", message: "invalid api key" } });
		}
		if (req.url === "/health") return send(200, { status: "ok" });
		if (req.url === "/ready") return send(200, { status: "ready", runtimes: 1 });
		if (req.url === "/v1/providers") {
			return send(200, {
				providers: [{ id: "url-fetch", type: "url-fetch", enabled: true, runtime: { mode: "any" } }],
			});
		}
		if (req.url === "/v1/runtimes") {
			return send(200, {
				runtimes: [
					{
						id: "runner-smoke",
						hostname: "smoke-host",
						os: "linux",
						version: "0.1.0",
						protocolVersion: "1",
						status: "online",
						labels: {},
						capabilities: {
							providerTypes: ["url-fetch"],
							providerIds: ["url-fetch"],
							browsers: [],
							profiles: [],
							http: true,
							browserAutomation: false,
						},
						capacity: { maxJobs: 2, activeJobs: 0 },
						lastSeenAt: Date.now(),
					},
				],
			});
		}
		if (req.url === "/v1/search") {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				send(200, {
					requestId: "req-smoke",
					traceId: "trace-smoke",
					status: "completed",
					items: [
						{
							id: "doc-1",
							platform: "web",
							type: "page",
							url: "https://example.com",
							title: "Smoke Title",
							markdown: "# Smoke Body\n\nhello from stub gateway",
							retrievedAt: new Date().toISOString(),
							provenance: {
								provider: "url-fetch",
								retrievalMethod: "http",
								requestId: "req-smoke",
								fetchedAt: new Date().toISOString(),
							},
						},
					],
					meta: {
						providers: {
							"url-fetch": { status: "success", latencyMs: 7, resultCount: 1 },
						},
					},
				});
			});
			return;
		}
		if (req.url === "/v1/admin/overview") {
			return send(200, {
				generatedAt: Date.now(),
				gateway: { status: "ready" },
				summary: {
					providers: 1,
					enabledProviders: 1,
					runtimes: 1,
					onlineRuntimes: 1,
					browserProfiles: 0,
					recentAudits: 1,
				},
				providers: [{ id: "url-fetch", type: "url-fetch", enabled: true }],
				runtimes: [{ id: "runner-smoke", status: "online", hostname: "smoke-host" }],
				browserProfiles: [],
				audits: [
					{
						requestId: "req-smoke",
						traceId: "trace-smoke",
						request: { query: "https://example.com" },
						createdAt: Date.now(),
						status: "completed",
						providers: [],
					},
				],
			});
		}
		if (req.url === "/v1/audit/req-smoke") {
			return send(200, {
				requestId: "req-smoke",
				traceId: "trace-smoke",
				request: { query: "https://example.com", sources: ["url-fetch"] },
				createdAt: Date.now() - 50,
				completedAt: Date.now(),
				status: "completed",
				providers: [
					{
						providerId: "url-fetch",
						runtimeId: "runner-smoke",
						startedAt: 0,
						completedAt: 20,
						status: "success",
						resultCount: 1,
					},
				],
			});
		}
		if (req.url === "/v1/providers/url-fetch/auth/check") {
			return send(200, {
				providerId: "url-fetch",
				runtimeId: "runner-smoke",
				auth: { status: "authenticated", account: { handle: "@smoke" }, checkedAt: Date.now() },
			});
		}
		send(404, { error: { code: "NOT_FOUND", message: `no stub route for ${req.url}` } });
	});
	return new Promise((resolvePort) => {
		server.listen(0, "127.0.0.1", () => resolvePort(server));
	});
}

/** 复刻 VCPToolBox/Plugin.js 的同步插件调用方式。 */
function invokePlugin(cwd, request) {
	return new Promise((resolveResult) => {
		const child = spawn(process.execPath, [pluginEntry], {
			cwd,
			shell: false,
			env: { ...process.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => resolveResult({ code: -1, stdout, stderr: String(error), parsed: null }));
		child.on("exit", (code) => {
			let parsed = null;
			try {
				parsed = JSON.parse(stdout.trim());
			} catch {
				parsed = null;
			}
			resolveResult({ code, stdout, stderr, parsed });
		});
		child.stdin.end(JSON.stringify(request));
	});
}

function textOf(parsed) {
	const content = parsed?.content ?? parsed?.result?.content ?? [];
	return content.map((item) => item.text ?? "").join("\n");
}

async function main() {
	const server = await startStubGateway();
	const port = server.address().port;
	const sandbox = mkdtempSync(join(tmpdir(), "aylens-bridge-smoke-"));
	writeFileSync(
		join(sandbox, "config.env"),
		`AYLENS_BASE_URL=http://127.0.0.1:${port}\nAYLENS_API_KEY=${API_KEY}\nREQUEST_TIMEOUT_MS=15000\n`,
		"utf8",
	);

	try {
		const search = await invokePlugin(sandbox, {
			command: "Search",
			maid: "Nova",
			query: "https://example.com",
			sources: "url-fetch",
			limit: "5",
		});
		check("Search: exit code 为 0", search.code === 0, `code=${search.code}`);
		check("Search: stdout 是唯一一个可解析 JSON", search.parsed !== null, search.stdout.slice(0, 120));
		check("Search: status=success", search.parsed?.status === "success");
		check("Search: 正文渲染进 content", textOf(search.parsed).includes("hello from stub gateway"));
		check("Search: 标题渲染进 content", textOf(search.parsed).includes("Smoke Title"));
		check("Search: messageForAI 存在", typeof search.parsed?.messageForAI === "string");
		check("Search: stderr 无噪音", search.stderr.trim() === "", search.stderr.slice(0, 120));

		const status = await invokePlugin(sandbox, { command: "GetStatus" });
		check("GetStatus: success", status.parsed?.status === "success");
		check("GetStatus: 报告在线 Runner", textOf(status.parsed).includes("在线 Runner=1"));

		const providers = await invokePlugin(sandbox, { command: "ListProviders" });
		check("ListProviders: 渲染 Provider", textOf(providers.parsed).includes("url-fetch · type=url-fetch"));

		const runtimes = await invokePlugin(sandbox, { command: "ListRuntimes" });
		check("ListRuntimes: 渲染节点", textOf(runtimes.parsed).includes("runner-smoke"));

		const overview = await invokePlugin(sandbox, { command: "GetOverview", recentAuditLimit: "3" });
		check("GetOverview: success", overview.parsed?.status === "success");
		check("GetOverview: 渲染摘要", textOf(overview.parsed).includes("Provider: 1/1 启用"));

		const audit = await invokePlugin(sandbox, { command: "GetAudit", requestId: "req-smoke" });
		check("GetAudit: success", audit.parsed?.status === "success");
		check("GetAudit: 展开 Provider 事件", textOf(audit.parsed).includes("url-fetch：success · 1 条"));

		const authCheck = await invokePlugin(sandbox, { command: "CheckProviderAuth", providerId: "url-fetch" });
		check("CheckProviderAuth: success", authCheck.parsed?.status === "success");
		check("CheckProviderAuth: 渲染登录态", textOf(authCheck.parsed).includes("登录态=authenticated"));

		const authLogin = await invokePlugin(sandbox, {
			command: "LoginProviderAuth",
			providerId: "url-fetch",
			confirm: "url-fetch",
		});
		check(
			"LoginProviderAuth: 未开启时默认拒绝",
			authLogin.parsed?.status === "error" && textOf(authLogin.parsed).includes("默认关闭"),
		);

		const unknown = await invokePlugin(sandbox, { command: "NoSuchCommand" });
		check("未知命令: status=error", unknown.parsed?.status === "error");
		check("未知命令: 仍以 0 退出且 stdout 合法", unknown.code === 0 && unknown.parsed !== null);

		const missingQuery = await invokePlugin(sandbox, { command: "Search" });
		check("缺 query: status=error", missingQuery.parsed?.status === "error");
		check("缺 query: 提示参数名", textOf(missingQuery.parsed).includes("query"));

		// 环境变量兜底：模拟 PluginStore 覆盖重装后 config.env 丢失的场景。
		const bare = mkdtempSync(join(tmpdir(), "aylens-bridge-smoke-bare-"));
		const envOnly = mkdtempSync(join(tmpdir(), "aylens-bridge-smoke-env-"));
		const missingKey = await invokePlugin(bare, { command: "GetStatus" });
		check(
			"config.env 缺失且无环境变量: 明确报错而不是静默",
			missingKey.parsed?.status === "error" && textOf(missingKey.parsed).includes("AYLENS_API_KEY"),
		);

		// 环境变量兜底可用时应当成功（VCPToolBox 会把 config.env 注入子进程 env）。
		const envFallback = await new Promise((resolveResult) => {
			const child = spawn(process.execPath, [pluginEntry], {
				cwd: envOnly,
				shell: false,
				env: {
					...process.env,
					AYLENS_BASE_URL: `http://127.0.0.1:${port}`,
					AYLENS_API_KEY: API_KEY,
				},
			});
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.on("exit", (code) => {
				let parsed = null;
				try {
					parsed = JSON.parse(stdout.trim());
				} catch {
					parsed = null;
				}
				resolveResult({ code, parsed });
			});
			child.stdin.end(JSON.stringify({ command: "GetStatus" }));
		});
		check("环境变量兜底: success", envFallback.parsed?.status === "success", `code=${envFallback.code}`);
		rmSync(bare, { recursive: true, force: true });
		rmSync(envOnly, { recursive: true, force: true });

		process.stdout.write(
			`\nAylensBridge stdio 冒烟：${passed} 通过，${failures.length} 失败${
				failures.length ? `（${failures.join(", ")}）` : ""
			}\n`,
		);
		process.exitCode = failures.length === 0 ? 0 : 1;
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
		server.close();
	}
}

main().catch((error) => {
	process.stderr.write(`[smoke] 未捕获异常：${String(error)}\n`);
	process.exitCode = 1;
});
