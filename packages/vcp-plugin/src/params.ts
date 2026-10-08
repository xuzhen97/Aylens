import { AylensBridgeError } from "./client.js";

/** VCP 参数是"扁平字段"，但也兼容一层嵌套 params。 */
export type VcpParams = Record<string, unknown>;

export function readString(params: VcpParams, key: string): string | undefined {
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}
	return String(value).trim() || undefined;
}

export function requireString(params: VcpParams, key: string): string {
	const value = readString(params, key);
	if (!value) {
		throw new AylensBridgeError(
			"INVALID_REQUEST",
			`缺少必填参数 ${key}。请检查 TOOL_REQUEST 中是否写成了 command 字段之外的正文。`,
		);
	}
	return value;
}

export function readNumber(params: VcpParams, key: string): number | undefined {
	const value = params[key];
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) {
		throw new AylensBridgeError("INVALID_REQUEST", `参数 ${key} 必须是数字，收到：${String(value)}`);
	}
	return parsed;
}

export function readStringArray(params: VcpParams, key: string): string[] | undefined {
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const list = value.map((item) => String(item).trim()).filter(Boolean);
		return list.length > 0 ? list : undefined;
	}
	const list = String(value)
		.split(/[,|\n]/)
		.map((item) => item.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}
