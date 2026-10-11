import type { AylensClient } from "../client.js";
import { formatAge, ok } from "../format.js";
import type { VcpResponse } from "../types.js";

interface HealthResponse {
	status: string;
}

interface ReadyResponse {
	status: string;
	runtimes: number;
}

/**
 * Runner 心跳上报的 Provider 操作能力。旧 Runner 不带该字段（可选），
 * 因此这里必须容忍缺失，渲染成「未上报」而不是报错或谎报支持。
 */
type ProviderOperations = Record<string, string[]>;

interface RuntimeRecord {
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

interface RuntimesResponse {
	runtimes: RuntimeRecord[];
}

interface ProvidersResponse {
	providers: Array<{ id: string; type: string; enabled: boolean; runtime: unknown }>;
}

/** 可作为执行节点的 Runer 状态：与 Gateway 的调度口径一致（offline / draining 不接活）。 */
function isSchedulable(runtime: RuntimeRecord): boolean {
	return runtime.status === "online" || runtime.status === "degraded";
}

/**
 * GetStatus —— Gateway 自身健康 + 在线 Runner 数量。
 * 注意：/ready 不代表所有 Provider 可用，它不是 Provider 探针。
 */
export async function handleGetStatus(client: AylensClient): Promise<VcpResponse> {
	const health = await client.get<HealthResponse>("/health");
	const ready = await client.get<ReadyResponse>("/ready");

	const lines = [
		`Aylens Gateway：health=${health.status} · ready=${ready.status} · 在线 Runner=${ready.runtimes}`,
	];
	if (ready.runtimes === 0) {
		lines.push(
			"",
			"⚠️ 没有任何在线 Runner：此时 /v1/search 会报「无可用执行节点」，这是设计如此（Gateway 不做任何抓取，没有本地回退）。",
		);
	}
	return ok(lines.join("\n"));
}

/** 渲染单个 Runner 的逐 Provider 能力行；未上报时如实说明，不假装已知。 */
function formatProviderOperations(runtime: RuntimeRecord): string {
	const entries = Object.entries(runtime.capabilities.providerOperations ?? {});
	if (entries.length === 0) {
		return "- Provider 能力: 未上报（该 Runner 版本较旧，或没有已加载实现的 Provider）";
	}
	return `- Provider 能力: ${entries.map(([id, operations]) => `${id}=${operations.join(",") || "无"}`).join(" · ")}`;
}

/** ListRuntimes —— 已连接的 Runner 执行节点及其能力。 */
export async function handleListRuntimes(client: AylensClient): Promise<VcpResponse> {
	const { runtimes } = await client.get<RuntimesResponse>("/v1/runtimes");
	if (runtimes.length === 0) {
		return ok("当前没有任何 Runner 注册到该 Gateway。");
	}

	const lines: string[] = [`共 ${runtimes.length} 个 Runner：`];
	for (const runtime of runtimes) {
		lines.push(
			"",
			`### ${runtime.id}`,
			`- 主机: ${runtime.hostname} · os=${runtime.os} · 版本=${runtime.version} · 协议=${runtime.protocolVersion}`,
			`- 状态: ${runtime.status} · 最后心跳: ${formatAge(runtime.lastSeenAt)}`,
			`- 容量: ${runtime.capacity.activeJobs}/${runtime.capacity.maxJobs}`,
			`- Provider 类型: ${runtime.capabilities.providerTypes.join(", ") || "（无）"}`,
			`- Provider 实例: ${runtime.capabilities.providerIds.join(", ") || "（无）"}`,
			formatProviderOperations(runtime),
			`- 浏览器: ${runtime.capabilities.browsers.join(", ") || "（无）"} · 自动化=${runtime.capabilities.browserAutomation} · HTTP=${runtime.capabilities.http}`,
			`- Profile: ${runtime.capabilities.profiles.join(", ") || "（无）"} · 代理配置通道=${runtime.capabilities.proxyConfig === true}`,
		);
		const labels = Object.entries(runtime.labels);
		if (labels.length > 0) {
			lines.push(`- 标签: ${labels.map(([k, v]) => `${k}=${v}`).join(", ")}`);
		}
	}
	return ok(lines.join("\n"));
}

/**
 * ListProviders —— Provider 定义 + **真实可用操作**。
 *
 * 能力不是猜的：Gateway 进程不加载 Provider 实现（factory 只在 Runner 侧注册），
 * 所以定义层回答不了「支不支持 extract」。真正的事实来自 Runner 心跳上报的
 * providerOperations。这里把它合并进来，调用方才敢对 API 渠道发 Extract。
 */
export async function handleListProviders(client: AylensClient): Promise<VcpResponse> {
	const [{ providers }, runtimesResponse] = await Promise.all([
		client.get<ProvidersResponse>("/v1/providers"),
		client.get<RuntimesResponse>("/v1/runtimes"),
	]);
	if (providers.length === 0) {
		return ok("该 Gateway 未配置任何 Provider。");
	}

	const schedulable = runtimesResponse.runtimes.filter(isSchedulable);
	/** providerId -> 声明支持它的在线 Runner。多个 Runner 声明不一致时逐条列出，不合并成假共识。 */
	const declaredBy = new Map<string, Array<{ runtimeId: string; operations: string[] }>>();
	let legacyRunnerCount = 0;
	for (const runtime of schedulable) {
		const reported = runtime.capabilities.providerOperations;
		if (!reported || Object.keys(reported).length === 0) {
			legacyRunnerCount += 1;
			continue;
		}
		for (const [providerId, operations] of Object.entries(reported)) {
			const claims = declaredBy.get(providerId) ?? [];
			claims.push({ runtimeId: runtime.id, operations });
			declaredBy.set(providerId, claims);
		}
	}

	const lines: string[] = [`共 ${providers.length} 个 Provider：`];
	for (const provider of providers) {
		lines.push(
			`- ${provider.id} · type=${provider.type} · enabled=${provider.enabled} · runtime=${JSON.stringify(provider.runtime)}`,
		);

		const claims = declaredBy.get(provider.id);
		if (claims && claims.length > 0) {
			lines.push(`  - 可用操作: ${claims.map((claim) => `${claim.operations.join(",") || "无"}@${claim.runtimeId}`).join(" · ")}`);
		} else if (schedulable.length === 0) {
			lines.push("  - 可用操作: 未知（当前没有在线 Runner）");
		} else {
			lines.push("  - 可用操作: 未上报（在线 Runner 没有声明这个 Provider）");
		}
	}

	const caveats: string[] = [];
	if (legacyRunnerCount > 0) {
		caveats.push(
			`有 ${legacyRunnerCount} 个在线 Runner 未上报 Provider 能力（旧版本）：它们的 Provider 会显示为「未上报」，实际可能仍支持 search。`,
		);
	}
	if (schedulable.length === 0) {
		caveats.push("当前没有在线 Runner，任何检索都会报「无可用执行节点」。");
	}

	lines.push(
		"",
		"调用 Search 时可用 sources 显式指定上述 id（如 sources=tavily 或 sources=tavily,exa），或改用 route 路由名。",
		"Extract **只有声明了 extract 的 Provider 可用**；`url-fetch` 与 `x` 不提供该能力。",
		...caveats,
	);
	return ok(lines.join("\n"));
}
