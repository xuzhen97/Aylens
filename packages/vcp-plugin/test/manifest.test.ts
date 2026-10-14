import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VCP_COMMANDS } from "../src/commands.js";

const manifestPath = resolve(__dirname, "../../../plugins/aylens/plugin-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

interface InvocationCommand {
	command?: string;
	commandIdentifier?: string;
	description: string;
	example: string;
	parameters?: Record<string, unknown>;
}

const commands = manifest.capabilities.invocationCommands as InvocationCommand[];

/** 与 VCPToolBox ToolCallParser._scanFields 等价的字段扫描。 */
function scanFields(blockContent: string): Array<{ key: string; value: string }> {
	const re = /([a-zA-Z_][a-zA-Z0-9_]*):「始」([^」]*)「末」/g;
	const fields: Array<{ key: string; value: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(blockContent))) {
		fields.push({ key: match[1] as string, value: match[2] as string });
	}
	return fields;
}

function blockOf(item: InvocationCommand): string {
	const start = item.example.indexOf("<<<[TOOL_REQUEST]>>>");
	const end = item.example.indexOf("<<<[END_TOOL_REQUEST]>>>");
	return item.example.slice(start + "<<<[TOOL_REQUEST]>>>".length, end);
}

describe("AylensBridge manifest 契约", () => {
	it("每条命令使用 command 而不是 commandIdentifier", () => {
		for (const item of commands) {
			expect("commandIdentifier" in item).toBe(false);
			expect(typeof item.command).toBe("string");
			expect(item.command?.length).toBeGreaterThan(0);
		}
	});

	it("命令集与 VCP_COMMANDS 完全一致", () => {
		expect(commands.map((item) => item.command).sort()).toEqual([...VCP_COMMANDS].sort());
	});

	it("每条示例都是完整的 TOOL_REQUEST 块", () => {
		for (const item of commands) {
			expect(item.example).toContain("<<<[TOOL_REQUEST]>>>");
			expect(item.example).toContain("<<<[END_TOOL_REQUEST]>>>");
		}
	});

	it("每条示例的 tool_name 为 AylensBridge，且 command 字段恰好出现一次并等于命令名", () => {
		for (const item of commands) {
			const fields = scanFields(blockOf(item));
			expect(fields.find((field) => field.key === "tool_name")?.value).toBe("AylensBridge");
			const commandFields = fields.filter((field) => field.key === "command");
			expect(commandFields).toHaveLength(1);
			expect(commandFields[0]?.value).toBe(item.command);
		}
	});

	it("Search 示例使用 query 字段承载检索本体", () => {
		const search = commands.find((item) => item.command === "Search");
		expect(search).toBeDefined();
		const fields = scanFields(blockOf(search as InvocationCommand));
		expect(fields.some((field) => field.key === "query")).toBe(true);
		expect(fields.filter((field) => field.key === "command")).toHaveLength(1);
	});

	it("不保留 VCPToolBox 不消费的 parameters 对象", () => {
		for (const item of commands) {
			expect("parameters" in item).toBe(false);
		}
	});

	it("插件身份字段与商店索引一致（name / pluginType / protocol）", () => {
		expect(manifest.name).toBe("AylensBridge");
		expect(manifest.pluginType).toBe("synchronous");
		expect(manifest.communication.protocol).toBe("stdio");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.capabilities.invocationCommands.length).toBeGreaterThan(0);
	});

	it("三处版本号必须一致（根 plugins.json 才是 PluginStore 判断更新的依据）", () => {
		const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
			version: string;
		};
		const rootIndex = JSON.parse(readFileSync(resolve(__dirname, "../../../plugins.json"), "utf8")) as {
			plugins: Array<{ name: string; version: string }>;
		};
		const entry = rootIndex.plugins.find((item) => item.name === "AylensBridge");
		expect(entry, "根 plugins.json 里缺少 AylensBridge 条目").toBeDefined();

		// 描述变更不会触发商店提示更新——只有根 plugins.json 的版本号变了才会。
		// 漏改任何一处，都会表现为「改了实现但用户永远收不到更新」。
		expect(packageJson.version).toBe(manifest.version);
		expect(entry?.version).toBe(manifest.version);
	});
});
