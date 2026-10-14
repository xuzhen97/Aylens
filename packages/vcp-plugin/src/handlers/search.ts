import { type AylensClient } from "../client.js";
import { renderSearchResponse, search } from "../../../bridge-core/src/index.js";
import { ok } from "../format.js";
import { readNumber, readString, readStringArray, requireString, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

/**
 * Search —— 薄适配：解析 VCP 扁平参数 → 调共享核心取值 → 用共享渲染排版 → 包成 VcpResponse。
 *
 * `query` 的语义随 Provider 变化（url-fetch 填 URL、x-search 填检索式、API 渠道填自然语言），
 * 这属于能力可见性，写在命令描述里（由 `bridge-core` 的渠道事实组装）。
 */
export async function handleSearch(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const query = requireString(params, "query");
	const route = readString(params, "route");
	const sources = readStringArray(params, "sources");
	const language = readString(params, "language");
	const limit = readNumber(params, "limit");

	const response = await search(client, {
		query,
		...(route === undefined ? {} : { route }),
		...(sources === undefined ? {} : { sources }),
		...(language === undefined ? {} : { language }),
		...(limit === undefined ? {} : { limit }),
	});

	const messageForAI =
		response.items.length > 0
			? `Aylens 检索命中 ${response.items.length} 条（status=${response.status}）。正文见下方。`
			: `Aylens 检索无命中（status=${response.status}）。`;

	return ok(renderSearchResponse(response), messageForAI);
}
