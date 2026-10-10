import { AylensBridgeError, type AylensClient } from "../client.js";
import { ok } from "../format.js";
import { readNumber, readString, readStringArray, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

const MAX_LIMIT = 100;
/** 单条正文上限；VCP 上下文预算有限，不整篇回灌。 */
const MAX_BODY_CHARS = 4_000;

interface ExtractItem {
	index: number;
	url: string;
	status: "success" | "failed";
	document?: { title?: string | undefined; markdown?: string | undefined; text?: string | undefined } | undefined;
	error?: { code: string; message: string; retryable: boolean } | undefined;
}

interface ExtractResponse {
	requestId: string;
	traceId: string;
	status: "completed" | "partial" | "failed";
	items: ExtractItem[];
	meta: { providers: Record<string, { status: string; error?: { code: string } | undefined }> };
}

function clip(value: string): string {
	return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}\n…（已截断）` : value;
}

/**
 * Extract —— 对显式 URL 列表取正文，与 Search 是两个独立能力。
 *
 * 必须显式给出 `sources`（例如 `tavily`）：提取不复用 search 的路由默认值，
 * 也不默认并行调用所有提取服务。
 */
export async function handleExtract(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const urls = readStringArray(params, "urls");
	const sources = readStringArray(params, "sources");
	const limit = readNumber(params, "limit");
	const format = readString(params, "format");

	if (!urls) {
		throw new AylensBridgeError("INVALID_REQUEST", "缺少必填参数 urls：请给出要提取的 HTTP(S) 地址列表。");
	}
	if (!sources) {
		throw new AylensBridgeError("INVALID_REQUEST", "缺少必填参数 sources：提取必须显式指定来源，不会默认调用所有服务。");
	}
	if (limit !== undefined && (limit <= 0 || limit > MAX_LIMIT)) {
		throw new AylensBridgeError("INVALID_REQUEST", `limit 必须在 1..${MAX_LIMIT} 之间，收到：${limit}`);
	}
	if (format !== undefined && format !== "markdown" && format !== "text") {
		throw new AylensBridgeError("INVALID_REQUEST", `format 只能是 markdown 或 text，收到：${format}`);
	}

	const body: Record<string, unknown> = { urls, sources };
	if (limit !== undefined) body.limit = limit;
	if (format !== undefined) body.content = { format };

	const response = await client.post<ExtractResponse>("/v1/extract", body);

	const succeeded = response.items.filter((item) => item.status === "success");
	const failed = response.items.filter((item) => item.status === "failed");

	const lines: string[] = [
		`提取状态：${response.status}（成功 ${succeeded.length} / 失败 ${failed.length}）`,
		"",
	];
	for (const item of succeeded) {
		const bodyText = clip(item.document?.markdown ?? item.document?.text ?? "");
		lines.push(`## ${item.document?.title ?? item.url}`);
		lines.push(`URL: ${item.url}`);
		lines.push("");
		lines.push(bodyText || "（无正文）");
		lines.push("");
	}
	if (failed.length > 0) {
		lines.push("### 失败");
		for (const item of failed) {
			// 只回错误码与本地安全文案，不透传上游原始 message。
			lines.push(`- ${item.url} → ${item.error?.code ?? "CONTENT_UNAVAILABLE"}`);
		}
	}

	if (succeeded.length === 0) {
		const details = Object.entries(response.meta?.providers ?? {})
			.map(([id, meta]) => `${id}: ${meta.error?.code ?? "FAILED"}`)
			.join("; ");
		throw new AylensBridgeError(
			"NO_RUNTIME",
			`Aylens 提取没有拿到任何正文（status=${response.status}）${details ? `：${details}` : ""}`,
		);
	}

	return ok(lines.join("\n"), `Aylens 提取完成：成功 ${succeeded.length} 条，失败 ${failed.length} 条（status=${response.status}）。`);
}
