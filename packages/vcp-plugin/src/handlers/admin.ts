import type { AylensClient } from "../client.js";
import { formatAge, ok } from "../format.js";
import { readNumber, requireString, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

interface AuditProviderEvent {
	providerId: string;
	runtimeId?: string | undefined;
	startedAt: number;
	completedAt: number;
	status: "success" | "failed";
	errorCode?: string | undefined;
	resultCount: number;
}

interface AuditRecord {
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

interface OverviewProvider {
	id: string;
	type: string;
	enabled: boolean;
	authControl?: boolean;
	authRuntimeId?: string;
	auth?: { status: string; account?: { handle: string } | undefined; checkedAt: number };
}

interface AdminOverview {
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
	browserProfiles: Array<{ id: string; runtimeId: string; status: string; activeLeases?: number; maxConcurrency?: number }>;
	audits: AuditRecord[];
}

function formatAudit(record: AuditRecord): string {
	const lines = [
		`审计 ${record.requestId} · status=${record.status}`,
		`- traceId: ${record.traceId}`,
		`- query: ${record.request.query}`,
	];
	if (record.request.sources?.length) lines.push(`- sources: ${record.request.sources.join(", ")}`);
	if (record.request.route) lines.push(`- route: ${record.request.route}`);
	if (record.request.limit !== undefined) lines.push(`- limit: ${record.request.limit}`);
	lines.push(
		`- 开始: ${new Date(record.createdAt).toISOString()}（${formatAge(record.createdAt)}）`,
	);
	if (record.completedAt !== undefined) {
		lines.push(`- 完成: ${new Date(record.completedAt).toISOString()} · 耗时 ${record.completedAt - record.createdAt}ms`);
	}
	if (record.providers.length === 0) {
		lines.push("- Provider 事件: （无——通常意味着在派发前就失败了）");
	} else {
		lines.push("- Provider 事件:");
		for (const event of record.providers) {
			lines.push(
				`  - ${event.providerId}：${event.status} · ${event.resultCount} 条 · ${event.completedAt - event.startedAt}ms` +
					`${event.runtimeId ? ` · runtime=${event.runtimeId}` : ""}${event.errorCode ? ` · ${event.errorCode}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

/** GetAudit —— 按 requestId 查单次检索的审计明细，是排查「为什么没结果」的第一现场。 */
export async function handleGetAudit(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const requestId = requireString(params, "requestId");
	const record = await client.get<AuditRecord>(`/v1/audit/${encodeURIComponent(requestId)}`);
	return ok(formatAudit(record));
}

/** GetOverview —— Gateway 总览：Provider 登录态、Runner、浏览器 Profile、最近审计。 */
export async function handleGetOverview(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const recentAuditLimit = readNumber(params, "recentAuditLimit");
	const overview = await client.get<AdminOverview>("/v1/admin/overview");
	const { summary } = overview;

	const lines = [
		`Aylens 总览 · gateway=${overview.gateway.status} · 生成于 ${formatAge(overview.generatedAt)}`,
		`- Provider: ${summary.enabledProviders}/${summary.providers} 启用`,
		`- Runner: ${summary.onlineRuntimes}/${summary.runtimes} 在线`,
		`- 浏览器 Profile: ${summary.browserProfiles}`,
		`- 近期审计: ${summary.recentAudits} 条`,
	];

	if (overview.providers.length > 0) {
		lines.push("", "## Providers");
		for (const provider of overview.providers) {
			const auth = provider.auth
				? ` · 登录态=${provider.auth.status}${provider.auth.account ? `（${provider.auth.account.handle}）` : ""}`
				: provider.authControl
					? " · 登录态=未知"
					: "";
			lines.push(`- ${provider.id} · type=${provider.type} · enabled=${provider.enabled}${auth}`);
		}
	}

	if (overview.runtimes.length > 0) {
		lines.push("", "## Runtimes");
		for (const runtime of overview.runtimes) {
			lines.push(`- ${runtime.id} · ${runtime.status}${runtime.hostname ? ` · ${runtime.hostname}` : ""}`);
		}
	}

	if (overview.browserProfiles.length > 0) {
		lines.push("", "## Browser Profiles");
		for (const profile of overview.browserProfiles) {
			lines.push(
				`- ${profile.id} · runtime=${profile.runtimeId} · ${profile.status}` +
					`${profile.activeLeases !== undefined && profile.maxConcurrency !== undefined ? ` · 租约 ${profile.activeLeases}/${profile.maxConcurrency}` : ""}`,
			);
		}
	}

	const audits = overview.audits.slice(
		0,
		recentAuditLimit !== undefined && recentAuditLimit > 0 ? recentAuditLimit : overview.audits.length,
	);
	if (audits.length > 0) {
		lines.push("", "## 最近审计");
		for (const record of audits) {
			lines.push(
				`- ${record.requestId} · ${record.status} · ${formatAge(record.createdAt)} · query=${record.request.query.slice(0, 60)}` +
					`${record.providers.some((event) => event.status === "failed") ? " · ⚠️ 有 Provider 失败" : ""}`,
			);
		}
		lines.push("", "用 GetAudit + requestId 查看单次检索的完整 Provider 事件。");
	}

	if (summary.onlineRuntimes === 0) {
		lines.push(
			"",
			"⚠️ 没有在线 Runner：此时任何 Search 都会报「无可用执行节点」（Gateway 不做本地回退）。",
		);
	}

	const needLogin = overview.providers
		.filter((provider) => provider.auth?.status === "auth_required")
		.map((provider) => provider.id);
	if (needLogin.length > 0) {
		lines.push(
			"",
			`⚠️ 以下 Provider 需要人工登录：${needLogin.join(", ")}。`,
			"请到 Aylens Admin 的 /admin/providers 点「登录」；登录态只留在 Runner 的 persistent Profile 里。",
		);
	}

	return ok(lines.join("\n"));
}
