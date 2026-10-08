import { AylensClient } from "./client.js";
import { loadConfig } from "./config.js";
import { dispatchCommand } from "./dispatcher.js";
import { fail, ok } from "./format.js";
import type { VcpRequest, VcpResponse } from "./types.js";

/**
 * AylensBridge —— VCPToolBox synchronous / stdio 插件入口。
 *
 * 运行契约（VCPToolBox/Plugin.js）：
 * - cwd 是插件目录（plugin.basePath），因此 config.env 就在 cwd；
 * - stdin 收到一个 JSON 字符串，随后被 end()；
 * - 同步插件在进程 exit 时 `JSON.parse(stdout.trim())` 解析**整个** stdout，
 *   所以这里只能 write 一次 JSON，且必须 exit(0)。日志一律走 stderr。
 */

function writeResponse(response: VcpResponse): void {
	const content = response.content ?? response.result?.content ?? [];
	const payload: Record<string, unknown> = {
		status: response.status,
		result: { content },
		content,
	};
	if (response.messageForAI !== undefined) payload.messageForAI = response.messageForAI;
	if (response.error !== undefined) payload.error = response.error;
	process.stdout.write(JSON.stringify(payload));
}

async function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

async function main(): Promise<void> {
	const raw = await readStdin();
	if (!raw.trim()) throw new Error("stdin 未收到任何输入");

	let request: VcpRequest;
	try {
		request = JSON.parse(raw) as VcpRequest;
	} catch {
		throw new Error(`stdin 不是合法 JSON：${raw.slice(0, 200)}`);
	}

	const config = loadConfig();
	const client = new AylensClient(config);
	writeResponse(await dispatchCommand(client, request));
}

main()
	.then(() => {
		process.exitCode = 0;
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[AylensBridge] ${message}\n`);
		writeResponse(fail(error));
		// 仍然以 0 退出：VCPToolBox 只在 stdout 无法解析为合法 JSON 时才 reject。
		process.exitCode = 0;
	});
