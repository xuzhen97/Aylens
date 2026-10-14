/**
 * VCP 协议载体的包装件。
 *
 * 契约镜像、取值与渲染都已迁到 `packages/bridge-core`；本文件只剩下
 * 「把结果或错误包成 VcpResponse」这一件事——它是 VCP 独有的。
 */
import { AylensBridgeError } from "../../bridge-core/src/client.js";
import type { VcpResponse } from "./types.js";

export function ok(text: string, messageForAI?: string): VcpResponse {
	const content = [{ type: "text" as const, text }];
	return messageForAI === undefined
		? { status: "success", result: { content }, content }
		: { status: "success", result: { content, messageForAI }, content, messageForAI };
}

export function fail(error: unknown): VcpResponse {
	const code = error instanceof AylensBridgeError ? error.code : "UNKNOWN";
	const message = error instanceof Error ? error.message : String(error);
	const text = `[AylensBridge:${code}] ${message}`;
	return {
		status: "error",
		error: message,
		result: { content: [{ type: "text", text }], messageForAI: text },
		content: [{ type: "text", text }],
		messageForAI: text,
	};
}
