import { defineTool } from "@deepseek-ai/dsh-tools";
import { type AylensClient } from "../../../bridge-core/src/client.js";
import { SEARCH_FACTS_TEXT } from "../../../bridge-core/src/capabilities.js";
import { search } from "../../../bridge-core/src/operations.js";
import { isSearchBodyTruncated, renderSearchResponse } from "../../../bridge-core/src/render.js";
import { assertConfigured } from "../config.js";
import { canonical } from "../canonical.js";

/**
 * 描述 = Aylens 的定位 + core 的渠道事实（逐字）。
 *
 * 「相对内置检索的不可替代场景」这段是刻意加的：DSH 自带 `web_search`，
 * 模型默认会用它，若不写明差异，这个插件等于形同虚设——
 * 与「渠道实现了但模型不知道」是同一种失败形状。
 */
const DESCRIPTION =
	"通过 Aylens Gateway 执行统一互联网检索，返回标题、URL、来源与正文。" +
	"当 DSH 内置的 web_search 覆盖不到下列场景时优先用本工具：" +
	"需要登录态的站点检索（如 X，内置检索只能拿到公开页面）；" +
	"已知 URL 且需要浏览器兜底抓取（含登录态、需要渲染的页面）；" +
	"需要 Tavily / Exa / AnySearch 多源汇集或 API Key 池调度。" +
	"纯公开网页的普通查资料用内置 web_search 更快。" +
	SEARCH_FACTS_TEXT;

export function buildSearchTool(client: AylensClient) {
	return defineTool({
		name: "aylens_search",
		description: DESCRIPTION,
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "检索式；语义随 sources 指定的渠道变化（URL / X 检索式 / 自然语言）。",
			},
			sources: {
				type: "array",
				items: { type: "string" },
				description: 'Provider 实例 id 列表，例如 ["tavily"] 或 ["tavily","exa"]；不填走默认路由。',
			},
			route: { type: "string", description: "Gateway 路由名，替代 sources。" },
			limit: { type: "number", description: "期望条数，1-100。" },
			language: { type: "string", description: "语言偏好。" },
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
					providers: {
						type: "array",
						required: true,
						items: { type: "object", additionalProperties: true },
					},
				},
			},
			render: (_args, value) => [{ type: "text", text: renderSearchResponse(value as never) }],
			// 结构化 sources 是渲染文本装不下的部分：经这里持久化，再由 presentResult 读回给 UI 画引用卡。
			presentationMeta: (_args, value) => {
				const response = value as unknown as {
					items: Array<{
						url: string;
						canonicalUrl?: string | undefined;
						title?: string | undefined;
						snippet?: string | undefined;
						publishedAt?: string | undefined;
						markdown?: string | undefined;
						text?: string | undefined;
					}>;
				};
				const items = response.items ?? [];
				return {
					sources: items.map((item) => ({
						url: item.canonicalUrl ?? item.url,
						...(item.title === undefined ? {} : { title: item.title }),
						...(item.snippet === undefined ? {} : { snippet: item.snippet }),
						...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
					})),
					// 如实上报：判定与渲染器同源（都在 bridge-core 的 render.ts），
					// 绝不能写死 false——否则正文被砍掉一半，卡片还说没截断。
					truncated: isSearchBodyTruncated(items),
				};
			},
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Aylens 检索：${(args as { query: string }).query}`,
		}),
		presentResult: (args, result) => {
			const meta = result.meta as { sources?: unknown[]; truncated?: boolean } | undefined;
			return {
				card: "web",
				kind: "search",
				title: `Aylens 检索：${(args as { query: string }).query}`,
				sources: (meta?.sources ?? []) as never,
				truncated: meta?.truncated === true,
			};
		},
		async execute(args, exec) {
			assertConfigured(client.config);
			const response = await search(
				client,
				{
					query: args.query,
					...(args.sources === undefined ? {} : { sources: args.sources }),
					...(args.route === undefined ? {} : { route: args.route }),
					...(args.limit === undefined ? {} : { limit: args.limit }),
					...(args.language === undefined ? {} : { language: args.language }),
				},
				exec.signal,
			);
			return {
				requestId: response.requestId,
				status: response.status,
				items: response.items.map((item) => canonical(item)),
				providers: Object.entries(response.meta?.providers ?? {}).map(([id, meta]) =>
					canonical({ id, ...meta }),
				),
			};
		},
	});
}
