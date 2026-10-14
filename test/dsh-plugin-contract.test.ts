import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { EXTRACT_FACTS_TEXT, SEARCH_FACTS_TEXT } from "../packages/bridge-core/src/capabilities.js";

/**
 * DSH 插件产物契约。
 *
 * 这是本设计里**唯一**的机械反漂移闸门：`bridge-core` 一改，两个宿主的产物都要重建，
 * 而渠道事实只写一遍——两侧组装出的描述必须逐字包含同一份文案。
 *
 * 刻意 import **已构建产物**（`dsh/index.mjs`）而不是源码：契约测试的职责是保证
 * 「分发出去的东西」是对的。漏构建会表现为测试与产物一起停在旧状态——这是刻意选择
 * （与 `vcp-plugin-contract.test.ts` 同一种纪律）。
 */

const root = resolve(__dirname, "..");
const dshDir = resolve(root, "packages/dsh-plugin");

interface ToolDefinition {
	name: string;
	description: string;
	parameters: { properties?: Record<string, unknown>; required?: string[] };
	output: { schema: unknown; render: unknown; presentationMeta?: unknown };
	execute: unknown;
}

const EXPECTED_TOOLS = ["aylens_search", "aylens_extract", "aylens_inspect", "aylens_login"];

/**
 * 参数契约的期望表。
 *
 * 为什么必须机械锁定：模型是从系统提示词里的 JSON Schema 学填参的，所以**参数名与必填性
 * 同样是公开接口**——把 `content` 改成 `format`、或把必填的 `sources` 变成可选，都是
 * 对模型的破坏性变更，绝不能全绿通过。（VCP 侧早有 `documentedParams()` 一一对应，
 * DSH 侧此前是缺口。）
 */
const EXPECTED_PARAMETERS: Record<string, { keys: string[]; required: string[] }> = {
	aylens_search: { keys: ["query", "sources", "route", "limit", "language"], required: ["query"] },
	aylens_extract: { keys: ["urls", "sources", "content", "limit"], required: ["urls", "sources"] },
	aylens_inspect: { keys: ["scope", "providerId", "requestId", "recentAuditLimit"], required: ["scope"] },
	aylens_login: { keys: ["providerId", "confirm"], required: ["providerId", "confirm"] },
};

let registered: ToolDefinition[] = [];
let builtSource = "";
let patchText = "";
let manifestText = "";
let packageJson: { name: string; files: string[]; main: string; dsh: { bundle: { patch: string } } };

beforeAll(async () => {
	const entry = pathToFileURL(resolve(dshDir, "dsh", "index.mjs")).href;
	const module = (await import(/* @vite-ignore */ entry)) as {
		name: string;
		inject: string[];
		apply(ctx: { tools: { register(definition: ToolDefinition): () => void } }, config?: unknown): void;
	};
	const context = {
		tools: {
			register: (definition: ToolDefinition) => {
				registered.push(definition);
				return () => {};
			},
		},
	};
	module.apply(context, {
		baseUrl: "http://127.0.0.1:3000",
		apiKey: "contract-test-key",
		requestTimeoutMs: 1000,
		allowAuthLogin: false,
	});
	expect(module.name).toBe("aylens-dsh");
	expect(module.inject).toEqual(["tools"]);

	builtSource = readFileSync(resolve(dshDir, "dsh", "index.mjs"), "utf8");
	patchText = readFileSync(resolve(dshDir, "dsh", "cordis.patch.yml"), "utf8");
	manifestText = readFileSync(resolve(root, "plugins", "aylens", "plugin-manifest.json"), "utf8");
	packageJson = JSON.parse(readFileSync(resolve(dshDir, "package.json"), "utf8")) as typeof packageJson;
});

describe("DSH 插件产物契约", () => {
	it("注册恰好 4 个原生工具，名字与顺序符合设计", () => {
		expect(registered.map((item) => item.name)).toEqual(EXPECTED_TOOLS);
	});

	it("每个工具都有 output.schema、output.render 与 execute，且参数非空", () => {
		for (const definition of registered) {
			expect(definition.output.schema, `${definition.name} 缺 output.schema`).toBeDefined();
			expect(typeof definition.output.render, `${definition.name} 缺 output.render`).toBe("function");
			expect(typeof definition.execute, `${definition.name} 缺 execute`).toBe("function");
			expect(
				Object.keys(definition.parameters.properties ?? {}).length,
				`${definition.name} 参数为空`,
			).toBeGreaterThan(0);
		}
	});

	it("每个工具的参数名与必填项都被机械锁定（参数名同样是公开接口）", () => {
		expect(registered.map((item) => item.name).sort()).toEqual(Object.keys(EXPECTED_PARAMETERS).sort());

		for (const definition of registered) {
			const expected = EXPECTED_PARAMETERS[definition.name];
			if (expected === undefined) throw new Error(`契约表缺少 ${definition.name}`);
			expect(
				Object.keys(definition.parameters.properties ?? {}).sort(),
				`${definition.name} 的参数名漂移`,
			).toEqual([...expected.keys].sort());
			expect(
				[...(definition.parameters.required ?? [])].sort(),
				`${definition.name} 的必填项漂移`,
			).toEqual([...expected.required].sort());
		}
	});

	it("产物自洽：除 @deepseek-ai/* 与 node: 内置模块外没有任何裸包 import", () => {
		const bare = [...builtSource.matchAll(/^\s*(?:import|export)[^;\n]*?from\s+["']([^"'.][^"']*)["']/gm)]
			.map((match) => match[1] as string)
			.filter((specifier) => !specifier.startsWith("@deepseek-ai/") && !specifier.startsWith("node:"));
		expect(bare).toEqual([]);
	});

	it("渠道事实只写一遍：DSH 与 VCP 两侧的描述都逐字包含 core 的同一份文案", () => {
		const search = registered.find((item) => item.name === "aylens_search");
		const extract = registered.find((item) => item.name === "aylens_extract");
		expect(search?.description).toContain(SEARCH_FACTS_TEXT);
		expect(extract?.description).toContain(EXTRACT_FACTS_TEXT);

		const manifest = JSON.parse(manifestText) as {
			capabilities: { invocationCommands: Array<{ command: string; description: string }> };
		};
		const vcpDescription = (command: string): string =>
			manifest.capabilities.invocationCommands.find((item) => item.command === command)?.description ?? "";
		expect(vcpDescription("Search")).toContain(SEARCH_FACTS_TEXT);
		expect(vcpDescription("Extract")).toContain(EXTRACT_FACTS_TEXT);
	});

	it("aylens_search 的描述写明相对内置 web_search 的不可替代场景", () => {
		const search = registered.find((item) => item.name === "aylens_search")?.description ?? "";
		expect(search).toContain("web_search");
	});

	it("aylens_login 的描述写明强副作用（拉起可见 Chrome、打断进行中任务、不等待登录）", () => {
		const login = registered.find((item) => item.name === "aylens_login")?.description ?? "";
		expect(login).toMatch(/Chrome/);
		expect(login).toMatch(/打断|中断/);
		expect(login).toMatch(/不等待/);
	});

	it("package.json 的 bundle 声明与 files 清单齐全（漏 files 会装上却不激活）", () => {
		expect(packageJson.name).toBe("aylens-dsh");
		expect(packageJson.dsh.bundle.patch).toBe("./dsh/cordis.patch.yml");
		expect(packageJson.main).toBe("./dsh/index.mjs");
		expect(packageJson.files).toContain("dsh/");
	});

	it("patch 行名等于包名，且 config 段不含任何密钥字段", () => {
		const layers = parseYaml(patchText) as Array<{ insert: Array<{ id: string; name: string; config: Record<string, unknown> }> }>;
		const inserted = layers[0]?.insert ?? [];
		const row = inserted.find((item) => item.name === "aylens-dsh");
		expect(row, "patch 里没有 aylens-dsh 行").toBeDefined();
		expect(row?.id).toBe("aylens-dsh");

		const configKeys = Object.keys(row?.config ?? {});
		expect(configKeys).toContain("baseUrl");
		expect(configKeys).toContain("allowAuthLogin");
		// 密钥绝不能落在这个文件里：它会被 dsh-config-manager 重写，也会随配置同步链路离开本机。
		for (const key of configKeys) {
			expect(key, `patch 的 config 段出现疑似密钥字段：${key}`).not.toMatch(/key|token|secret|password/i);
		}
	});

	it("patch 的 config 段给出的默认值符合设计（allowAuthLogin 默认关闭）", () => {
		const layers = parseYaml(patchText) as Array<{ insert: Array<{ name: string; config: Record<string, unknown> }> }>;
		const row = (layers[0]?.insert ?? []).find((item) => item.name === "aylens-dsh");
		expect(row?.config.allowAuthLogin).toBe(false);
		expect(row?.config.baseUrl).toBe("http://127.0.0.1:3000");
	});
});
