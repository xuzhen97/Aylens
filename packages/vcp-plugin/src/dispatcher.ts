import type { AylensClient } from "./client.js";
import { AylensBridgeError } from "./client.js";
import { COMMANDS } from "./commands.js";
import type { VcpParams } from "./params.js";
import type { VcpRequest, VcpResponse } from "./types.js";

/**
 * 把 VCP 请求（扁平字段 + 可选一层嵌套 params）归一化成参数字典。
 */
export function normalizeParams(request: VcpRequest): VcpParams {
	const { command: _command, params: nested, maid: _maid, ...flat } = request as Record<string, unknown>;
	return { ...flat, ...((nested as Record<string, unknown> | undefined) ?? {}) };
}

/**
 * 分发执行 VCP 指令。
 */
export async function dispatchCommand(
	client: AylensClient,
	request: VcpRequest,
): Promise<VcpResponse> {
	const command = typeof request.command === "string" ? request.command.trim() : "";
	if (!command) {
		throw new AylensBridgeError(
			"INVALID_REQUEST",
			`缺少 command 字段。可用命令：${COMMANDS.map((item) => item.name).join(", ")}`,
		);
	}

	const definition = COMMANDS.find((item) => item.name === command);
	if (!definition) {
		throw new AylensBridgeError(
			"INVALID_REQUEST",
			`未知命令 "${command}"。可用命令：${COMMANDS.map((item) => item.name).join(", ")}`,
		);
	}

	return definition.run(client, normalizeParams(request));
}
