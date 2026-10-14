import { defineTool } from "@deepseek-ai/dsh-tools";
import { type AylensClient } from "../../../bridge-core/src/client.js";
import {
	checkProviderAuth,
	getAudit,
	getOverview,
	getStatus,
	listProviders,
	listRuntimes,
} from "../../../bridge-core/src/operations.js";
import {
	renderAudit,
	renderOverview,
	renderProviderAuth,
	renderProviders,
	renderRuntimes,
	renderStatus,
} from "../../../bridge-core/src/render.js";
import { assertConfigured } from "../config.js";
import { canonical } from "../canonical.js";

/** `scope` 与 Gateway 命令的映射（诊断面合并成一个工具的理由见下）。 */
const SCOPES = ["gateway", "overview", "runtimes", "providers", "provider-auth", "audit"] as const;
type Scope = (typeof SCOPES)[number];

/**
 * 把 GetStatus / GetOverview / ListRuntimes / ListProviders / CheckProviderAuth / GetAudit
 * 六条诊断命令合并进一个 `scope` 枚举。
 *
 * 合并理由：这六条都是排查用的诊断面，逐条成器会给系统提示词塞进六份几乎不会被调用的
 * schema。而 `provider-auth` 与 `audit` 的条件必填在 JSON Schema 里表达不了，只能在
 * `execute` 里挡——错误信息必须指路，否则模型只会反复试错。
 */
const DESCRIPTION =
	"查看 Aylens Gateway 的诊断信息，排查「检索不好用」时先看 overview。" +
	"scope 取值与用途：" +
	"gateway = Gateway 健康与在线 Runner 数；" +
	"overview = 总览（Provider 登录态、Runner、浏览器 Profile、最近审计）；" +
	"runtimes = 已连接 Runner 的能力与容量；" +
	"providers = Provider 清单与各自**真实可用操作**（决定 aylens_search / aylens_extract 能用哪些 sources）；" +
	"provider-auth = 检查某个 Provider 的人工登录态（无副作用，需 providerId）；" +
	"audit = 按 requestId 看单次检索的审计明细（需 requestId）。" +
	"注意：没有任何在线 Runner 时检索会报 NO_RUNTIME，这意味着执行面缺失，**不是查无结果**。";

export function buildInspectTool(client: AylensClient) {
	return defineTool({
		name: "aylens_inspect",
		description: DESCRIPTION,
		parameters: {
			scope: {
				type: "string",
				enum: [...SCOPES],
				required: true,
				description: "要查看的诊断面。",
			},
			providerId: {
				type: "string",
				description: 'scope="provider-auth" 时必填；取值来自 scope="providers" 返回的 Provider id。',
			},
			requestId: {
				type: "string",
				description: 'scope="audit" 时必填；来自 aylens_search 的返回值或 scope="overview" 的近期审计列表。',
			},
			recentAuditLimit: {
				type: "number",
				description: 'scope="overview" 时限制列出的近期审计条数。',
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					scope: { type: "string", required: true },
					// 渲染文本给模型读；data 保留结构化原值，供后续工具或 Code Mode 程序化消费。
					text: { type: "string", required: true },
					data: { type: "object", required: true, additionalProperties: true },
				},
			},
			render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Aylens 诊断：${(args as { scope: Scope }).scope}`,
		}),
		async execute(args, exec) {
			assertConfigured(client.config);
			const scope = args.scope as Scope;

			// 条件必填在这里挡：schema 表达不了，错误信息必须指路。
			if (scope === "provider-auth" && !args.providerId) {
				throw new Error(
					'scope="provider-auth" 必须传 providerId，取值来自 aylens_inspect(scope="providers") 返回的 Provider id。',
				);
			}
			if (scope === "audit" && !args.requestId) {
				throw new Error(
					'scope="audit" 必须传 requestId，取值来自 aylens_search 返回的 requestId，或 aylens_inspect(scope="overview") 的近期审计列表。',
				);
			}

			switch (scope) {
				case "gateway": {
					const data = await getStatus(client, exec.signal);
					return { scope, text: renderStatus(data), data: canonical(data) };
				}
				case "overview": {
					const data = await getOverview(client, exec.signal);
					return {
						scope,
						text: renderOverview(data, args.recentAuditLimit),
						data: canonical(data),
					};
				}
				case "runtimes": {
					const data = await listRuntimes(client, exec.signal);
					return { scope, text: renderRuntimes(data.runtimes), data: canonical(data) };
				}
				case "providers": {
					const data = await listProviders(client, exec.signal);
					return { scope, text: renderProviders(data), data: canonical(data) };
				}
				case "provider-auth": {
					const data = await checkProviderAuth(
						client,
						{ providerId: args.providerId as string },
						exec.signal,
					);
					return { scope, text: renderProviderAuth(data), data: canonical(data) };
				}
				default: {
					const data = await getAudit(client, { requestId: args.requestId as string }, exec.signal);
					return { scope, text: renderAudit(data), data: canonical(data) };
				}
			}
		},
	});
}
