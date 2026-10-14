/**
 * Aylens Gateway 的契约镜像。
 *
 * 刻意**不从 `src/contracts/*.ts` import**：两个宿主适配层的产物都必须自洽、
 * 可脱离 Aylens 源码树分发，不能被内部源码路径绑住。这些接口逐字镜像 Gateway 的
 * 实际响应形状，字段名与可选性与 `packages/vcp-plugin` 抽取前的定义保持一致。
 */

export interface HealthResponse {
	status: string;
}

export interface ReadyResponse {
	status: string;
	runtimes: number;
}

export interface SearchDocument {
	id: string;
	platform: string;
	type: string;
	url: string;
	canonicalUrl?: string | undefined;
	title?: string | undefined;
	text?: string | undefined;
	snippet?: string | undefined;
	markdown?: string | undefined;
	publishedAt?: string | undefined;
	retrievedAt: string;
	score?: number | undefined;
	provenance: {
		provider: string;
		retrievalMethod: string;
		providerItemId?: string | undefined;
		requestId: string;
		fetchedAt: string;
		runtimeId?: string | undefined;
	};
	extensions?: Record<string, unknown> | undefined;
}

export interface ProviderExecutionMeta {
	status: "success" | "failed";
	runtimeId?: string | undefined;
	latencyMs: number;
	resultCount: number;
	error?: { code: string; message: string; retryable: boolean } | undefined;
}

export interface SearchResponse {
	requestId: string;
	traceId: string;
	status: "completed" | "partial" | "failed";
	items: SearchDocument[];
	meta: { providers: Record<string, ProviderExecutionMeta> };
}

export interface ExtractItem {
	index: number;
	url: string;
	status: "success" | "failed";
	document?: { title?: string | undefined; markdown?: string | undefined; text?: string | undefined } | undefined;
	error?: { code: string; message: string; retryable: boolean } | undefined;
}

export interface ExtractResponse {
	requestId: string;
	traceId: string;
	status: "completed" | "partial" | "failed";
	items: ExtractItem[];
	meta: { providers: Record<string, { status: string; error?: { code: string } | undefined }> };
}

/**
 * Runner 心跳上报的 Provider 操作能力。旧 Runner 不带该字段（可选），
 * 因此消费方必须容忍缺失，渲染成「未上报」而不是报错或谎报支持。
 */
export type ProviderOperations = Record<string, string[]>;

export interface RuntimeRecord {
	id: string;
	hostname: string;
	os: string;
	version: string;
	protocolVersion: string;
	status: string;
	labels: Record<string, string>;
	capabilities: {
		providerTypes: string[];
		providerIds: string[];
		authProviderIds?: string[];
		/** 逐 Provider 的真实操作能力（search / extract / usage）。缺失 = 旧 Runner，未上报。 */
		providerOperations?: ProviderOperations;
		browsers: string[];
		profiles: string[];
		proxyConfig?: boolean;
		http: boolean;
		browserAutomation: boolean;
	};
	capacity: { maxJobs: number; activeJobs: number };
	lastSeenAt: number;
}

export interface RuntimesResponse {
	runtimes: RuntimeRecord[];
}

export interface ProvidersResponse {
	providers: Array<{ id: string; type: string; enabled: boolean; runtime: unknown }>;
}

export interface ProviderAuthAccount {
	handle: string;
	displayName?: string | undefined;
}

export interface ProviderAuthState {
	status: "unknown" | "authenticated" | "auth_required";
	account?: ProviderAuthAccount | undefined;
	checkedAt: number;
}

export interface ProviderAuthResponse {
	providerId: string;
	runtimeId: string;
	auth: ProviderAuthState;
}

export interface AuditProviderEvent {
	providerId: string;
	runtimeId?: string | undefined;
	startedAt: number;
	completedAt: number;
	status: "success" | "failed";
	errorCode?: string | undefined;
	resultCount: number;
}

export interface AuditRecord {
	requestId: string;
	traceId: string;
	request: {
		query: string;
		route?: string | undefined;
		sources?: string[] | undefined;
		limit?: number | undefined;
		language?: string | undefined;
	};
	createdAt: number;
	completedAt?: number | undefined;
	status: "running" | "completed" | "partial" | "failed" | "interrupted";
	providers: AuditProviderEvent[];
}

export interface OverviewProvider {
	id: string;
	type: string;
	enabled: boolean;
	authControl?: boolean;
	authRuntimeId?: string;
	auth?: { status: string; account?: { handle: string } | undefined; checkedAt: number };
}

export interface AdminOverview {
	generatedAt: number;
	gateway: { status: string };
	summary: {
		providers: number;
		enabledProviders: number;
		runtimes: number;
		onlineRuntimes: number;
		browserProfiles: number;
		recentAudits: number;
	};
	providers: OverviewProvider[];
	runtimes: Array<{ id: string; status: string; hostname?: string }>;
	browserProfiles: Array<{
		id: string;
		runtimeId: string;
		status: string;
		activeLeases?: number;
		maxConcurrency?: number;
	}>;
	audits: AuditRecord[];
}
