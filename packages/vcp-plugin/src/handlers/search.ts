import { AylensBridgeError, type AylensClient } from "../client.js";
import { formatSearchResponse, ok, type SearchResponse } from "../format.js";
import { readNumber, readString, readStringArray, requireString, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

const MAX_LIMIT = 100;

/**
 * Search —— Aylens 的核心能力。
 *
 * query 的语义随 Provider 变化：
 * - url-fetch：query 直接写 URL，走 HTTP 优先 + 浏览器兜底；
 * - x-search：query 写 X 检索式（如 `"OpenAI" lang:en`）。
 */
export async function handleSearch(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const query = requireString(params, "query");
	const route = readString(params, "route");
	const sources = readStringArray(params, "sources");
	const language = readString(params, "language");
	const limit = readNumber(params, "limit");

	if (limit !== undefined && (limit <= 0 || limit > MAX_LIMIT)) {
		throw new AylensBridgeError(
			"INVALID_REQUEST",
			`limit 必须在 1..${MAX_LIMIT} 之间，收到：${limit}`,
		);
	}

	const body: Record<string, unknown> = { query };
	if (route !== undefined) body.route = route;
	if (sources !== undefined) body.sources = sources;
	if (language !== undefined) body.language = language;
	if (limit !== undefined) body.limit = limit;

	const response = await client.post<SearchResponse>("/v1/search", body);

	if (response.status === "failed" && response.items.length === 0) {
		const details = Object.entries(response.meta?.providers ?? {})
			.map(([id, meta]) => `${id}: ${meta.error?.code ?? "FAILED"} ${meta.error?.message ?? ""}`.trim())
			.join("; ");
		throw new AylensBridgeError(
			"NO_RUNTIME",
			`Aylens 检索整体失败（requestId=${response.requestId}）${details ? `：${details}` : ""}`,
		);
	}

	const text = formatSearchResponse(response);
	const messageForAI =
		response.items.length > 0
			? `Aylens 检索命中 ${response.items.length} 条（status=${response.status}）。正文见下方。`
			: `Aylens 检索无命中（status=${response.status}）。`;

	return ok(text, messageForAI);
}
