#!/usr/bin/env node
/**
 * aylens-dsh 实机冒烟：在**临时 profile** 里真装一次插件，确认它进了层栈。
 *
 * 刻意不碰 `~/.dsh/profiles/desktop`：验收是 Task 8 的事，这一步只回答
 * 「`dsh plugin add` + bundle patch 这条链路对本地路径的包成不成立」。
 *
 * 用法：
 *   node scripts/smoke-dsh-plugin.mjs              只做装配验证
 *   AYLENS_SMOKE=1 node scripts/smoke-dsh-plugin.mjs   额外对真 Gateway 跑一次检索
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "dsh-plugin");
const profileName = `aylens-dsh-smoke-${process.pid}`;
const tempHome = mkdtempSync(join(tmpdir(), "dsh-smoke-home-"));

/** Windows 的 `.cmd` 垫片必须经 shell 启动，而 shell + args 会触发 Node 的 DEP0190 弃用警告。
 *  因此这里把参数自行拼成一条命令字符串（带引号），只传命令、不传 args 数组。 */
function quote(argument) {
	return /[\s"]/u.test(argument) ? `"${argument.replace(/"/gu, '""')}"` : argument;
}

function dsh(args) {
	const command = [process.platform === "win32" ? "dsh.cmd" : "dsh", ...args.map(quote)].join(" ");
	return execFileSync(command, {
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: tempHome },
		stdio: ["ignore", "pipe", "pipe"],
		shell: true,
	});
}

let failed = false;
try {
	console.log(`[smoke] 临时 DSH_HOME = ${tempHome}`);

	// 1) 起一个全新 profile 并装入本地路径的插件包
	dsh(["plugin", "--profile", profileName, "add", packageDir]);
	console.log("[smoke] OK: dsh plugin add 成功");

	// 2) 合成后的配置树里必须出现我们那一层
	const dump = dsh(["--profile", profileName, "--dump-config"]);
	if (!dump.includes("aylens-dsh")) {
		throw new Error("--dump-config 的输出里没有 aylens-dsh 层");
	}
	console.log("[smoke] OK: aylens-dsh 已进入 profile 层栈");

	// 3) 可选：对真 Gateway 跑一次检索
	if (process.env.AYLENS_SMOKE === "1") {
		const entry = pathToFileURL(join(packageDir, "dsh", "index.mjs")).href;
		const module = await import(entry);
		const tools = [];
		module.apply(
			{
				tools: {
					register: (definition) => {
						tools.push(definition);
						return () => {};
					},
				},
			},
			// 注意：这里传空 config，凭据不是从它来的——`resolveConfig` 会去读
			// `process.env.AYLENS_API_KEY`，也就是上面 env 里注入的那一份。
			{},
		);
		const searchTool = tools.find((item) => item.name === "aylens_search");
		if (searchTool === undefined) throw new Error("产物里没有 aylens_search");
		const value = await searchTool.execute(
			{ query: "https://example.com", sources: ["url-fetch"], limit: 1 },
			{ signal: AbortSignal.timeout(120_000) },
		);
		console.log(`[smoke] OK: 真实检索命中 ${value.items.length} 条`);
	} else {
		console.log("[smoke] 跳过真实检索（设 AYLENS_SMOKE=1 启用）");
	}
} catch (error) {
	failed = true;
	console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
	if (error instanceof Error && error.stdout) console.error(String(error.stdout).slice(0, 2000));
	if (error instanceof Error && error.stderr) console.error(String(error.stderr).slice(0, 2000));
} finally {
	try {
		rmSync(tempHome, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
}

process.exit(failed ? 1 : 0);
