/**
 * Aylens Gateway 的九条操作——**只取值，不排版**。
 *
 * 铁律：本文件的所有函数**只返回结构化值**，绝不返回渲染文本。
 * VCP 侧要一段 Markdown、DSH 侧要「规范值 + 各自的呈现」，这是两个宿主能共用同一份核心的前提。
 * 异常消息里可以有文本；**返回值里不行**。
 *
 * 渲染在 `render.ts`；扁平协议参数的解析与校验在各宿主适配层。
 */
import { AylensBridgeError, type AylensClient } from "./client.js";
import type {
	AdminOverview,
	ExtractResponse,
	HealthResponse,
	ProviderAuthResponse,
	ProvidersResponse,
	ReadyResponse,
	RuntimeRecord,
	RuntimesResponse,
	SearchResponse,
	AuditRecord,
} from "./contracts.js";

/** 检索与提取的条数上限，两个宿主共用同一口径。 */
export const MAX_LIMIT = 100;

export interface SearchInput {
	query: string;
	sources?: string[];
	route?: string;
	limit?: number;
	language?: string;
}

export interface ExtractInput {
	urls: string[];
	sources: string[];
	content?: "markdown" | "text";
	limit?: number;
}

function assertLimit(limit: number | undefined): void {
	if (limit !== undefined && (limit <= 0 || limit > MAX_LIMIT)) {
		throw new AylensBridgeError("INVALID_REQUEST", `limit 必须在 1..${MAX_LIMIT} 之间，收到：${limit}`);
	}
}

/**
 * Search —— Aylens 的核心能力。
 *
 * `query` 的语义随 Provider 变化（url-fetch 填 URL、x-search 填 X 检索式、
 * API 渠道填自然语言），这属于能力可见性，由 `capabilities.ts` 承载、宿主写进描述。
 */
export async function search(
	client: AylensClient,
	input: SearchInput,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	assertLimit(input.limit);

	const body: Record<string, unknown> = { query: input.query };
	if (input.route !== undefined) body.route = input.route;
	if (input.sources !== undefined) body.sources = input.sources;
	if (input.language !== undefined) body.language = input.language;
	if (input.limit !== undefined) body.limit = input.limit;

	const response = await client.post<SearchResponse>("/v1/search", body, signal);

	// 「全部 Provider 失败」不等于「查无结果」。这条判据是把零命中且整体失败升格成错误，
	// 并把每个 Provider 的根因拼进消息——否则模型只会看到「没搜到」。
	if (response.status === "failed" && response.items.length === 0) {
		const details = Object.entries(response.meta?.providers ?? {})
			.map(([id, meta]) => `${id}: ${meta.error?.code ?? "FAILED"} ${meta.error?.message ?? ""}`.trim())
			.join("; ");
		throw new AylensBridgeError(
			"NO_RUNTIME",
			`Aylens 检索整体失败（requestId=${response.requestId}）${details ? `：${details}` : ""}`,
		);
	}

	return response;
}

/**
 * Extract —— 对显式 URL 列表取正文，与 Search 是两个独立能力。
 *
 * 必须显式给出 `sources`：提取不复用 Search 的路由默认值，也不默认并行调用所有提取服务。
 */
export async function extract(
	client: AylensClient,
	input: ExtractInput,
	signal?: AbortSignal,
): Promise<ExtractResponse> {
	if (input.urls.length === 0) {
		throw new AylensBridgeError("INVALID_REQUEST", "缺少必填参数 urls：请给出要提取的 HTTP(S) 地址列表。");
	}
	if (input.sources.length === 0) {
		throw new AylensBridgeError(
			"INVALID_REQUEST",
			"缺少必填参数 sources：提取必须显式指定来源，不会默认调用所有服务。",
		);
	}
	assertLimit(input.limit);

	const body: Record<string, unknown> = { urls: input.urls, sources: input.sources };
	if (input.limit !== undefined) body.limit = input.limit;
	if (input.content !== undefined) body.content = { format: input.content };

	const response = await client.post<ExtractResponse>("/v1/extract", body, signal);

	// 一条正文都没拿到 = 执行面问题，不是「这些页面没内容」。
	const succeeded = response.items.filter((item) => item.status === "success");
	if (succeeded.length === 0) {
		const details = Object.entries(response.meta?.providers ?? {})
			.map(([id, meta]) => `${id}: ${meta.error?.code ?? "FAILED"}`)
			.join("; ");
		throw new AylensBridgeError(
			"NO_RUNTIME",
			`Aylens 提取没有拿到任何正文（status=${response.status}）${details ? `：${details}` : ""}`,
		);
	}

	return response;
}

/**
 * Gateway 自身健康 + 在线 Runner 数量。
 * 注意：`/ready` 不代表所有 Provider 可用，它不是 Provider 探针。
 */
export async function getStatus(
	client: AylensClient,
	signal?: AbortSignal,
): Promise<{ health: HealthResponse; ready: ReadyResponse }> {
	const health = await client.get<HealthResponse>("/health", undefined, signal);
	const ready = await client.get<ReadyResponse>("/ready", undefined, signal);
	return { health, ready };
}

/** Gateway 总览：Provider 登录态、Runner、浏览器 Profile、最近审计。 */
export function getOverview(client: AylensClient, signal?: AbortSignal): Promise<AdminOverview> {
	return client.get<AdminOverview>("/v1/admin/overview", undefined, signal);
}

/** 已连接的 Runner 执行节点及其能力。 */
export function listRuntimes(client: AylensClient, signal?: AbortSignal): Promise<RuntimesResponse> {
	return client.get<RuntimesResponse>("/v1/runtimes", undefined, signal);
}

/**
 * Provider 定义 + **真实可用操作**。
 *
 * 能力不是猜的：Gateway 进程不加载 Provider 实现（factory 只在 Runner 侧注册），
 * 定义层回答不了「支不支持 extract」。真正的事实来自 Runner 心跳上报的
 * `capabilities.providerOperations`，所以这里必须把 `/v1/runtimes` 一起取回来。
 */
export async function listProviders(
	client: AylensClient,
	signal?: AbortSignal,
): Promise<{ providers: ProvidersResponse["providers"]; runtimes: RuntimeRecord[] }> {
	const [providersResponse, runtimesResponse] = await Promise.all([
		client.get<ProvidersResponse>("/v1/providers", undefined, signal),
		client.get<RuntimesResponse>("/v1/runtimes", undefined, signal),
	]);
	return { providers: providersResponse.providers, runtimes: runtimesResponse.runtimes };
}

/** 只读登录态，无副作用。 */
export function checkProviderAuth(
	client: AylensClient,
	input: { providerId: string },
	signal?: AbortSignal,
): Promise<ProviderAuthResponse> {
	return client.post<ProviderAuthResponse>(
		`/v1/providers/${encodeURIComponent(input.providerId)}/auth/check`,
		undefined,
		signal,
	);
}

/**
 * 在 Runner 上启动一个**可见的**普通 Chrome 并打开登录页。
 *
 * 这是本插件唯一的强副作用能力：它会打断目标机器上正在复用同一 Profile 的浏览器操作，
 * 因此默认关闭，并要求 `confirm` 与 `providerId` 全等作为二次确认。
 * 两道闸门都开在这里，两个宿主各自的上层都无法绕过。
 */
export async function loginProviderAuth(
	client: AylensClient,
	input: { providerId: string; confirm: string },
	signal?: AbortSignal,
): Promise<ProviderAuthResponse> {
	if (!client.config.allowAuthLogin) {
		throw new AylensBridgeError(
			"AUTH_LOGIN_DISABLED",
			"登录 Provider 默认关闭：它会在 Runner 上拉起一个可见 Chrome 并可能打断同 Profile 的进行中任务。" +
				"确认要启用时，请显式打开 allowAuthLogin（VCP 侧为 AYLENS_ALLOW_AUTH_LOGIN=true，DSH 侧为 patch config 的 allowAuthLogin）。",
		);
	}
	if (input.confirm !== input.providerId) {
		throw new AylensBridgeError(
			"AUTH_LOGIN_DISABLED",
			`二次确认未通过：请把 confirm 写成与 providerId 完全相同的值（当前 providerId=${input.providerId}）。`,
		);
	}

	return client.post<ProviderAuthResponse>(
		`/v1/providers/${encodeURIComponent(input.providerId)}/auth/login`,
		undefined,
		signal,
	);
}

/** 按 requestId 查单次检索的审计明细，是排查「为什么没结果」的第一现场。 */
export function getAudit(
	client: AylensClient,
	input: { requestId: string },
	signal?: AbortSignal,
): Promise<AuditRecord> {
	return client.get<AuditRecord>(`/v1/audit/${encodeURIComponent(input.requestId)}`, undefined, signal);
}
