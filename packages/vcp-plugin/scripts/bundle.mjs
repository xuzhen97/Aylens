#!/usr/bin/env node
/**
 * AylensBridge 构建脚本。
 *
 * 产物：
 *   1. plugins/aylens/index.cjs            —— esbuild 打成单文件 CJS（零 npm 运行时依赖）
 *   2. plugins/aylens/plugin-manifest.json —— 用 commands.ts 重新生成 capabilities.invocationCommands
 *   3. dist/AylensBridge.zip               —— PluginStore 卡片安装实际下载的载荷（三文件平铺）
 *
 * 为什么 manifest 的命令清单要生成而不是手写：见 src/commands.ts 的注释——
 * 手写清单和实现之间一定会漂移，而商店列表、示例、参数说明全都依赖它。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { strToU8, unzipSync, zipSync } from "fflate";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const rootDir = resolve(packageDir, "..", "..");
const pluginDir = join(rootDir, "plugins", "aylens");
const distDir = join(rootDir, "dist");
const manifestPath = join(pluginDir, "plugin-manifest.json");
const bundlePath = join(pluginDir, "index.cjs");
const zipPath = join(distDir, "AylensBridge.zip");

const REQUIRED_ENTRIES = ["plugin-manifest.json", "index.cjs", "config.env.example"];

function readManifest() {
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`无法读取 ${manifestPath}`, { cause: error });
	}
}

async function generateInvocationCommands() {
	const compiled = pathToFileURL(join(packageDir, "dist", "commands.js")).href;
	const module = await import(compiled);
	if (typeof module.buildInvocationCommands !== "function") {
		throw new Error("dist/commands.js 未导出 buildInvocationCommands，请先执行 tsc");
	}
	return {
		invocationCommands: module.buildInvocationCommands(),
		commandNames: module.VCP_COMMANDS,
		toolName: module.TOOL_NAME,
	};
}

function syncManifest(manifest, invocationCommands) {
	const next = {
		...manifest,
		capabilities: { ...(manifest.capabilities ?? {}), invocationCommands },
	};
	writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

async function bundleEntry() {
	await build({
		entryPoints: [join(packageDir, "dist", "index.js")],
		outfile: bundlePath,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node18",
		legalComments: "none",
		banner: { js: "#!/usr/bin/env node" },
		logLevel: "warning",
	});
}

function packageZip() {
	if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
	const archive = zipSync(
		{
			"plugin-manifest.json": strToU8(readFileSync(manifestPath, "utf8")),
			"index.cjs": strToU8(readFileSync(bundlePath, "utf8")),
			"config.env.example": strToU8(readFileSync(join(pluginDir, "config.env.example"), "utf8")),
		},
		{ level: 9 },
	);
	writeFileSync(zipPath, archive);
	return archive.length;
}

function verifyZip() {
	const entries = Object.keys(unzipSync(readFileSync(zipPath)));
	const sorted = [...entries].sort();
	const expected = [...REQUIRED_ENTRIES].sort();
	if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
		throw new Error(
			`zip 内容不符合预期。期望 ${expected.join(", ")}，实际 ${sorted.join(", ")}`,
		);
	}
}

function verifyManifest(manifest, commandNames, toolName) {
	if (manifest.name !== toolName) {
		throw new Error(`manifest.name(${manifest.name}) 必须等于 TOOL_NAME(${toolName})`);
	}
	const declared = (manifest.capabilities?.invocationCommands ?? []).map((item) => item.command);
	if (JSON.stringify([...declared].sort()) !== JSON.stringify([...commandNames].sort())) {
		throw new Error(`manifest 命令集与 COMMANDS 不一致：${declared.join(", ")}`);
	}
	if (manifest.pluginType !== "synchronous") throw new Error("pluginType 必须是 synchronous");
	if (manifest.communication?.protocol !== "stdio") throw new Error("communication.protocol 必须是 stdio");
}

async function main() {
	const manifest = readManifest();
	const { invocationCommands, commandNames, toolName } = await generateInvocationCommands();
	const synced = syncManifest(manifest, invocationCommands);
	await bundleEntry();
	const bytes = packageZip();
	verifyZip();
	verifyManifest(synced, commandNames, toolName);
	process.stdout.write(
		`[vcp-plugin] plugins/aylens/index.cjs + plugin-manifest.json 已同步；` +
			`dist/AylensBridge.zip ${bytes} bytes（${REQUIRED_ENTRIES.length} 个条目）\n`,
	);
}

main().catch((error) => {
	process.stderr.write(`[vcp-plugin] 构建失败：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
