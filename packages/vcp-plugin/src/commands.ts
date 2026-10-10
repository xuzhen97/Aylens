import type { AylensClient } from "./client.js";
import { handleGetAudit, handleGetOverview } from "./handlers/admin.js";
import { handleCheckProviderAuth, handleLoginProviderAuth } from "./handlers/providers.js";
import { handleExtract } from "./handlers/extract.js";
import { handleSearch } from "./handlers/search.js";
import { handleGetStatus, handleListProviders, handleListRuntimes } from "./handlers/system.js";
import type { VcpParams } from "./params.js";
import type { VcpResponse } from "./types.js";

/** VCP 工具名。必须与 plugin-manifest.json 的 name、plugins.json 的 key 完全一致。 */
export const TOOL_NAME = "AylensBridge";

/** 示例 TOOL_REQUEST 里的署名，与 VCPDeckBridge 保持一致。 */
const EXAMPLE_MAID = "Nova";

export interface ExampleParam {
	key: string;
	value: string;
}

export interface CommandDefinition {
	name: string;
	/** 写入 plugin-manifest.json 的 capabilities.invocationCommands[].description。 */
	description: string;
	/** 生成示例块用的扁平字段，顺序即输出顺序。 */
	exampleParams: ExampleParam[];
	run(client: AylensClient, params: VcpParams): Promise<VcpResponse>;
}

/**
 * 唯一命令注册表。
 *
 * plugin-manifest.json 的 capabilities 由本表在构建时生成（scripts/bundle.mjs），
 * 因此不存在"改了实现忘了改清单"的漂移窗口；manifest 契约测试会再次校验。
 */
export const COMMANDS: CommandDefinition[] = [
	{
		name: "Search",
		description:
			"功能: 通过 Aylens Gateway 执行统一互联网检索（url-fetch / x-search 等 Provider），返回标题、URL、来源与正文 Markdown。\n" +
			"`command` 固定为 `Search`，不得填写 URL、路径或自然语言。\n" +
			"`query` 是检索内容本体：抓取指定网页时直接写该 URL；X 检索时写 X 检索式。\n" +
			"`sources` 可显式指定 Provider 实例（逗号分隔），`route` 可指定 Gateway 路由名，二者都不填则走默认路由。\n" +
			"`limit` 为期望条数（1-100），`language` 为语言偏好。",
		exampleParams: [
			{ key: "query", value: "https://example.com" },
			{ key: "sources", value: "url-fetch" },
			{ key: "limit", value: "5" },
		],
		run: handleSearch,
	},
	{
		name: "Extract",
		description:
			"功能: 对显式 URL 列表提取正文（与 Search 是两个独立能力），返回 Markdown 或纯文本、逐条成功/失败状态。\n" +
			"`command` 固定为 `Extract`，不得填写 URL、路径或自然语言。\n" +
			"`urls` 是要提取的 HTTP(S) 地址列表（逗号或换行分隔）。\n" +
			"`sources` 必填，指定提取来源（如 `tavily`）；不会默认调用所有提取服务，也不复用 Search 的默认路由。\n" +
			"`limit` 为期望返回条数（1-100），`content` 控制正文格式（markdown 或 text）。",
		exampleParams: [
			{ key: "urls", value: "https://example.com/article" },
			{ key: "sources", value: "tavily" },
			{ key: "content", value: "markdown" },
		],
		run: handleExtract,
	},
	{
		name: "GetStatus",
		description:
			"功能: 查看 Aylens Gateway 健康状态与在线 Runner 数量，用于判断检索是否具备执行节点。\n" +
			"`command` 固定为 `GetStatus`，不得填写其他内容。",
		exampleParams: [],
		run: (client) => handleGetStatus(client),
	},
	{
		name: "GetOverview",
		description:
			"功能: 获取 Gateway 总览：Provider 清单与登录态、Runner、浏览器 Profile、最近审计。排查「检索不好用」先看这里。\n" +
			"`command` 固定为 `GetOverview`，不得填写其他内容。\n" +
			"`recentAuditLimit` 可限制列出的近期审计条数。",
		exampleParams: [{ key: "recentAuditLimit", value: "5" }],
		run: handleGetOverview,
	},
	{
		name: "ListRuntimes",
		description:
			"功能: 列出已连接 Runner 节点的状态、容量、Provider 能力、浏览器与 Profile。\n" +
			"`command` 固定为 `ListRuntimes`，不得填写其他内容。",
		exampleParams: [],
		run: (client) => handleListRuntimes(client),
	},
	{
		name: "ListProviders",
		description:
			"功能: 列出 Gateway 已配置的 Provider 实例（id / type / enabled / runtime），用于确定 Search 的 sources 取值。\n" +
			"`command` 固定为 `ListProviders`，不得填写其他内容。",
		exampleParams: [],
		run: (client) => handleListProviders(client),
	},
	{
		name: "CheckProviderAuth",
		description:
			"功能: 检查指定 Provider 的人工登录态（无副作用）。返回 authenticated / auth_required / unknown 与当前账号。\n" +
			"`command` 固定为 `CheckProviderAuth`，不得填写其他内容；`providerId` 用 ListProviders 返回的 id。",
		exampleParams: [{ key: "providerId", value: "x" }],
		run: handleCheckProviderAuth,
	},
	{
		name: "LoginProviderAuth",
		description:
			"功能: 在 Runner 上拉起一个可见 Chrome 并打开该 Provider 的登录页（**强副作用**，会打断同 Profile 的进行中任务，且不等待登录完成）。\n" +
			"默认关闭，需在插件 config.env 设 AYLENS_ALLOW_AUTH_LOGIN=true 才可用。\n" +
			"`command` 固定为 `LoginProviderAuth`，不得填写其他内容；`providerId` 为目标 Provider，`confirm` 必须与 `providerId` 完全相同作为二次确认。",
		exampleParams: [
			{ key: "providerId", value: "x" },
			{ key: "confirm", value: "x" },
		],
		run: handleLoginProviderAuth,
	},
	{
		name: "GetAudit",
		description:
			"功能: 按 requestId 查看单次检索的审计明细（状态、耗时、每个 Provider 的成败与错误码）。\n" +
			"`command` 固定为 `GetAudit`，不得填写其他内容；`requestId` 来自 Search 返回的 requestId 或 GetOverview 的近期审计列表。",
		exampleParams: [{ key: "requestId", value: "req-xxxxxxxx" }],
		run: handleGetAudit,
	},
];

/** 命令标识符清单（供 manifest 契约测试引用）。 */
export const VCP_COMMANDS: readonly string[] = COMMANDS.map((command) => command.name);

/** 生成一个完整的 TOOL_REQUEST 示例块。 */
export function buildExample(command: CommandDefinition): string {
	const lines = [
		"<<<[TOOL_REQUEST]>>>",
		`maid:「始」${EXAMPLE_MAID}「末」,`,
		`tool_name:「始」${TOOL_NAME}「末」,`,
		`command:「始」${command.name}「末」,`,
	];
	for (const param of command.exampleParams) {
		lines.push(`${param.key}:「始」${param.value}「末」,`);
	}
	lines.push("<<<[END_TOOL_REQUEST]>>>");
	return lines.join("\n");
}

/** 生成 plugin-manifest.json 的 capabilities.invocationCommands。 */
export function buildInvocationCommands(): Array<{
	command: string;
	description: string;
	example: string;
}> {
	return COMMANDS.map((command) => ({
		command: command.name,
		description: command.description,
		example: buildExample(command),
	}));
}
