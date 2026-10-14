import { AylensBridgeError, type AylensClient } from "../client.js";
import { extract, renderExtractResponse } from "../../../bridge-core/src/index.js";
import { ok } from "../format.js";
import { readNumber, readString, readStringArray, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

/**
 * Extract —— 对显式 URL 列表取正文，与 Search 是两个独立能力。
 *
 * 必须显式给出 `sources`：提取不复用 Search 的路由默认值，也不默认并行调用所有提取服务。
 *
 * **参数名修正**：描述与示例一直写 `content`，而历史上的实现只读 `format`，
 * 于是模型按描述发送的参数被静默忽略。现在 `content` 是正式参数名，
 * `format` 作为旧别名继续容忍。
 */
export async function handleExtract(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const urls = readStringArray(params, "urls");
	const sources = readStringArray(params, "sources");
	const limit = readNumber(params, "limit");
	const content = readString(params, "content") ?? readString(params, "format");

	if (content !== undefined && content !== "markdown" && content !== "text") {
		throw new AylensBridgeError(
			"INVALID_REQUEST",
			`content 只能是 markdown 或 text，收到：${content}`,
		);
	}

	const response = await extract(client, {
		urls: urls ?? [],
		sources: sources ?? [],
		...(limit === undefined ? {} : { limit }),
		...(content === undefined ? {} : { content }),
	});

	const succeeded = response.items.filter((item) => item.status === "success");
	const failed = response.items.filter((item) => item.status === "failed");

	return ok(
		renderExtractResponse(response),
		`Aylens 提取完成：成功 ${succeeded.length} 条，失败 ${failed.length} 条（status=${response.status}）。`,
	);
}
