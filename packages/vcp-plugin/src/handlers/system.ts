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

/** ListProviders —— Gateway 侧配置的 Provider definition。 */
export async function handleListProviders(client: AylensClient): Promise<VcpResponse> {
	const { providers } = await client.get<ProvidersResponse>("/v1/providers");
	if (providers.length === 0) {
		return ok("该 Gateway 未配置任何 Provider。");
	}

	const lines = [`共 ${providers.length} 个 Provider：`];
	for (const provider of providers) {
		lines.push(
			`- ${provider.id} · type=${provider.type} · enabled=${provider.enabled} · runtime=${JSON.stringify(provider.runtime)}`,
		);
	}
	lines.push(
		"",
		"调用 Search 时可用 sources 显式指定上述 id（如 sources=A,B），或改用 route 路由名。",
	);
	return ok(lines.join("\n"));
}
