#!/usr/bin/env node
/**
 * aylens-dsh 打包脚本。
 *
 * 产物：`dsh/index.mjs` —— 把 `bridge-core` 内联进去的自洽 ESM 单文件。
 * `@deepseek-ai/*` 一律 external：由宿主在装配期解析到安装目录里的同一份
 * （profile resolution 拦截层，已实证），内联反而会打错版本。
 *
 * 纪律：本脚本**只允许覆盖 `dsh/index.mjs`**，不得清空 `dsh/` 目录——
 * 同目录的 `cordis.patch.yml` 是手写源件，删掉它插件层会在下次启动时整层消失。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const dshDir = join(packageDir, "dsh");
const outfile = join(dshDir, "index.mjs");
const patchFile = join(dshDir, "cordis.patch.yml");

if (!existsSync(patchFile)) {
	throw new Error(`dsh/cordis.patch.yml 缺失：${patchFile}（它是手写源件，不该被构建清掉）`);
}
mkdirSync(dshDir, { recursive: true });

await build({
	entryPoints: [join(packageDir, "src", "index.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["@deepseek-ai/*"],
	legalComments: "none",
	logLevel: "warning",
});

process.stdout.write("[dsh-plugin] dsh/index.mjs 已生成（@deepseek-ai/* 保持 external）\n");
