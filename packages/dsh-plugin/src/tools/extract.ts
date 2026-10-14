import { defineTool } from "@deepseek-ai/dsh-tools";
import { type AylensClient } from "../../../bridge-core/src/client.js";
import { EXTRACT_FACTS_TEXT } from "../../../bridge-core/src/capabilities.js";
import { extract } from "../../../bridge-core/src/operations.js";
import { isExtractBodyTruncated, renderExtractResponse } from "../../../bridge-core/src/render.js";
import { assertConfigured } from "../config.js";
import { canonical } from "../canonical.js";

const DESCRIPTION =
	"对显式 URL 列表提取正文（与 aylens_search 是两个独立能力），返回逐条成功/失败状态。" +
	EXTRACT_FACTS_TEXT;

export function buildExtractTool(client: AylensClient) {
	return defineTool({
		name: "aylens_extract",
		description: DESCRIPTION,
		parameters: {
			urls: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "要提取的 HTTP(S) 地址列表。",
			},
			sources: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: '提取来源，例如 ["tavily"]；必填，不会默认调用所有服务。',
			},
			content: {
				type: "string",
				enum: ["markdown", "text"],
				description: "正文格式偏好；注意 exa 只能给纯文本。",
			},
			limit: { type: "number", description: "期望返回条数，1-100。" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					requestId: { type: "string", required: true },
					status: { type: "string", required: true },
					items: {
						type: "array",
						required: true,
						items: { type: "object", additionalProperties: true },
					},
					succeeded: { type: "number", required: true },
					failed: { type: "number", required: true },
				},
			},
			render: (_args, value) => [{ type: "text", text: renderExtractResponse(value as never) }],
			presentationMeta: (args, value) => {
				const items = (value as unknown as {
					items: Array<{
						url: string;
						status: string;
						document?: { markdown?: string | undefined; text?: string | undefined } | undefined;
					}>;
				}).items;
				const urls = (args as { urls: string[] }).urls;
				const only = items[0];

				// `kind:'fetch'` 卡的 url / statusCode 是单数，装不下批量结果。
				// 而且**只有这一条真的成功了**才配这张卡：ADR retrieval-capability-contracts 明确
				// 「不能仅凭 HTTP 200 判定所有项成功」。失败的单 URL 退回通用卡，绝不臆造 HTTP 码。
				if (urls.length !== 1 || only === undefined || only.status !== "success") {
					return { kind: "list" };
				}
				return {
					kind: "fetch",
					url: only.url,
					statusCode: 200,
					truncated: isExtractBodyTruncated([only.document ?? {}]),
				};
			},
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Aylens 提取 ${((args as { urls?: string[] }).urls ?? []).length} 个 URL`,
		}),
		presentResult: (args, result) => {
			const meta = result.meta as
				| { kind?: string; url?: string; statusCode?: number; truncated?: boolean }
				| undefined;
			if (meta?.kind === "fetch" && typeof meta.url === "string") {
				return {
					card: "web",
					kind: "fetch",
					url: meta.url,
					statusCode: meta.statusCode ?? 200,
					truncated: meta.truncated === true,
				};
			}
			return {
				card: "generic",
				title: `Aylens 提取 ${((args as { urls?: string[] }).urls ?? []).length} 个 URL`,
			};
		},
		async execute(args, exec) {
			assertConfigured(client.config);
			const response = await extract(
				client,
				{
					urls: args.urls,
					sources: args.sources,
					...(args.content === undefined ? {} : { content: args.content }),
					...(args.limit === undefined ? {} : { limit: args.limit }),
				},
				exec.signal,
			);
			return {
				requestId: response.requestId,
				status: response.status,
				items: response.items.map((item) => canonical(item)),
				succeeded: response.items.filter((item) => item.status === "success").length,
				failed: response.items.filter((item) => item.status === "failed").length,
			};
		},
	});
}
