/**
 * 结构化结果 → 给 AI 读的 Markdown。
 *
 * 与 `operations.ts` 严格分工：那里只取值，这里只排版。
 * 两个宿主共用同一份排版，再由各自的上层包成自己的协议载体
 * （VCP 包成 `VcpResponse`，DSH 包成工具的内容块）。
 *
 * 不转义任何文档正文——Markdown 是 Aylens 的正式契约
 * （见 ADR `search-document-markdown-contract`）。
 */
import type {
	AdminOverview,
	AuditRecord,
	ExtractResponse,
	HealthResponse,
	ProviderAuthResponse,
	ProvidersResponse,
	ReadyResponse,
	RuntimeRecord,
	SearchDocument,
	SearchResponse,
} from "./contracts.js";

/** 单篇文档的正文上限（字符）。 */
export const MAX_DOC_BODY_CHARS = 4_000;
/** 整次返回的正文总上限（字符）。模型上下文不是无限预算。 */
export const MAX_TOTAL_BODY_CHARS = 28_000;
/** snippet / text 摘要上限。 */
export const MAX_SNIPPET_CHARS = 600;

/** 只关心正文体的文段（SearchDocument 与 ExtractItem.document 都满足）。 */
export interface BodyBearing {
	markdown?: string | undefined;
	text?: string | undefined;
}

function bodyOf(item: BodyBearing): string {
	return (item.markdown ?? item.text ?? "").trim();
}

/**
 * Search 侧：在「逐篇 4k + 总量 28k」的预算下，这批正文是否会被截断。
 *
 * 存在的理由：宿主需要向上层**如实上报** `truncated`。若让每个宿主各自推算一遍预算，
 * 那套数字迟早与渲染器漂移，结果是「被砍掉一半的结果标着未截断」——一种静默谎报。
 * 因此预算的判定与使用同住一处，并由测试钉住它与渲染输出的一致性。
 */
export function isSearchBodyTruncated(items: ReadonlyArray<BodyBearing>): boolean {
	let budget = MAX_TOTAL_BODY_CHARS;
	for (const item of items) {
		const body = bodyOf(item);
		if (!body) continue;
		const allowed = Math.max(0, Math.min(MAX_DOC_BODY_CHARS, budget));
		// 预算已耗尽（后续正文整段省略），或本篇装不下（本篇截断）。
		if (allowed === 0) return true;
		if (body.length > allowed) return true;
		budget -= body.length;
	}
	return false;
}

/**
 * Extract 侧：逐篇 4k，**没有总量上限**，因此判定口径与 Search 不同。
 * 口径不同就必须各写一个函数——合成一个会掩盖差异。
 */
export function isExtractBodyTruncated(items: ReadonlyArray<BodyBearing>): boolean {
	return items.some((item) => bodyOf(item).length > MAX_DOC_BODY_CHARS);
}

/** 把毫秒时间戳渲染成人类可读的相对时间。 */
export function formatAge(timestamp: number): string {
	const deltaMs = Date.now() - timestamp;
	if (!Number.isFinite(deltaMs)) return "未知";
	if (deltaMs < 0) return "刚刚";
	const seconds = Math.round(deltaMs / 1000);
	if (seconds < 60) return `${seconds}s 前`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m 前`;
	return `${Math.round(minutes / 60)}h 前`;
}

function truncate(text: string, limit: number): { value: string; truncated: boolean } {
	if (text.length <= limit) return { value: text, truncated: false };
	return { value: text.slice(0, limit), truncated: true };
}

function summarize(doc: SearchDocument): string | undefined {
	const source = doc.snippet ?? doc.text;
	if (!source) return undefined;
	return truncate(source.replace(/\s+/g, " ").trim(), MAX_SNIPPET_CHARS).value;
}

/** SearchResponse → Markdown。 */
export function renderSearchResponse(response: SearchResponse): string {
	const lines: string[] = [];
	const providerEntries = Object.entries(response.meta?.providers ?? {});
	const okProviders = providerEntries.filter(([, meta]) => meta.status === "success");
	const failedProviders = providerEntries.filter(([, meta]) => meta.status === "failed");

	lines.push(
		`检索完成 · status=${response.status} · 命中 ${response.items.length} 条 · requestId=${response.requestId}`,
	);

	if (providerEntries.length > 0) {
		lines.push(
			`Provider：${okProviders.length}/${providerEntries.length} 成功`,
			...providerEntries.map(([id, meta]) => {
				const base = `- ${id}：${meta.status} · ${meta.resultCount} 条 · ${meta.latencyMs}ms${
					meta.runtimeId ? ` · runtime=${meta.runtimeId}` : ""
				}`;
				return meta.error ? `${base} · ${meta.error.code}: ${meta.error.message}` : base;
			}),
		);
	}

	if (failedProviders.length > 0 && response.items.length === 0) {
		lines.push("", "⚠️ 全部 Provider 失败，上面每行的 error 就是根因；不要把它当成「查无结果」。");
	}

	if (response.items.length === 0 && failedProviders.length === 0) {
		lines.push(
			"",
			"（合法空结果：Provider 已执行但没有命中。若这不符合预期，检查 Gateway 的 route / sources 配置。）",
		);
	}

	let bodyBudget = MAX_TOTAL_BODY_CHARS;
	response.items.forEach((doc, index) => {
		const title = doc.title?.trim() || `（无标题）${doc.id}`;
		lines.push("", `### ${index + 1}. ${title}`);
		lines.push(`- URL: ${doc.canonicalUrl ?? doc.url}`);
		lines.push(
			`- 来源: ${doc.platform} · provider=${doc.provenance.provider} · method=${doc.provenance.retrievalMethod}`,
		);
		if (doc.publishedAt) lines.push(`- 发布: ${doc.publishedAt}`);
		lines.push(`- 抓取: ${doc.retrievedAt}`);
		if (doc.provenance.runtimeId) lines.push(`- runtime: ${doc.provenance.runtimeId}`);

		const snippet = summarize(doc);
		if (snippet) lines.push(`- 摘要: ${snippet}`);

		const body = doc.markdown ?? doc.text;
		if (body && body.trim()) {
			const budget = Math.max(0, Math.min(MAX_DOC_BODY_CHARS, bodyBudget));
			if (budget > 0) {
				const { value, truncated } = truncate(body.trim(), budget);
				bodyBudget -= value.length;
				lines.push("", truncated ? `${value}\n\n…（正文已截断）` : value);
			} else {
				lines.push("", "…（正文总量已达上限，剩余文档正文省略）");
			}
		}
	});

	return lines.join("\n");
}

/** ExtractResponse → Markdown。单条正文超限时截断并标注。 */
export function renderExtractResponse(response: ExtractResponse): string {
	const clip = (value: string): string =>
		value.length > MAX_DOC_BODY_CHARS ? `${value.slice(0, MAX_DOC_BODY_CHARS)}\n…（已截断）` : value;

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
	return lines.join("\n");
}

/** Gateway 健康 + 在线 Runner 数量 → Markdown。 */
export function renderStatus(status: { health: HealthResponse; ready: ReadyResponse }): string {
	const lines = [
		`Aylens Gateway：health=${status.health.status} · ready=${status.ready.status} · 在线 Runner=${status.ready.runtimes}`,
	];
	if (status.ready.runtimes === 0) {
		lines.push(
			"",
			"⚠️ 没有任何在线 Runner：此时 /v1/search 会报「无可用执行节点」，这是设计如此（Gateway 不做任何抓取，没有本地回退）。",
		);
	}
	return lines.join("\n");
}

/** 可作为执行节点的 Runner 状态：与 Gateway 的调度口径一致（offline / draining 不接活）。 */
function isSchedulable(runtime: RuntimeRecord): boolean {
	return runtime.status === "online" || runtime.status === "degraded";
}

/** 渲染单个 Runner 的逐 Provider 能力行；未上报时如实说明，不假装已知。 */
function formatProviderOperations(runtime: RuntimeRecord): string {
	const entries = Object.entries(runtime.capabilities.providerOperations ?? {});
	if (entries.length === 0) {
		return "- Provider 能力: 未上报（该 Runner 版本较旧，或没有已加载实现的 Provider）";
	}
	return `- Provider 能力: ${entries.map(([id, operations]) => `${id}=${operations.join(",") || "无"}`).join(" · ")}`;
}

/** Runner 列表 → Markdown。 */
export function renderRuntimes(runtimes: RuntimeRecord[]): string {
	if (runtimes.length === 0) {
		return "当前没有任何 Runner 注册到该 Gateway。";
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
	return lines.join("\n");
}

/**
 * Provider 清单 + **真实可用操作** → Markdown。
 *
 * 能力不是猜的：Gateway 进程不加载 Provider 实现，所以定义层回答不了「支不支持 extract」。
 * 真正的事实来自 Runner 心跳上报的 `providerOperations`。缺失时如实说「未上报」或「未知」，
 * 绝不谎报支持。
 */
export function renderProviders(input: {
	providers: ProvidersResponse["providers"];
	runtimes: RuntimeRecord[];
}): string {
	if (input.providers.length === 0) {
		return "该 Gateway 未配置任何 Provider。";
	}

	const schedulable = input.runtimes.filter(isSchedulable);
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

	const lines: string[] = [`共 ${input.providers.length} 个 Provider：`];
	for (const provider of input.providers) {
		lines.push(
			`- ${provider.id} · type=${provider.type} · enabled=${provider.enabled} · runtime=${JSON.stringify(provider.runtime)}`,
		);

		const claims = declaredBy.get(provider.id);
		if (claims && claims.length > 0) {
			lines.push(
				`  - 可用操作: ${claims.map((claim) => `${claim.operations.join(",") || "无"}@${claim.runtimeId}`).join(" · ")}`,
			);
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
	return lines.join("\n");
}

/** Provider 登录态 → Markdown。 */
export function renderProviderAuth(response: ProviderAuthResponse): string {
	const { auth } = response;
	const lines = [`Provider ${response.providerId} · runtime=${response.runtimeId} · 登录态=${auth.status}`];
	if (auth.account) {
		lines.push(
			`- 账号: ${auth.account.handle}${auth.account.displayName ? `（${auth.account.displayName}）` : ""}`,
		);
	}
	if (auth.checkedAt) {
		lines.push(`- 检查时间: ${new Date(auth.checkedAt).toISOString()}（${formatAge(auth.checkedAt)}）`);
	}
	if (auth.status === "auth_required") {
		lines.push(
			"",
			"⚠️ 需要人工登录：请在 Aylens Admin（/admin/providers）点「登录」，在弹出的 Chrome 里完成登录与 2FA。",
			"凭据只留在 Runner 的 persistent Profile 中，Gateway 不接触 Cookie。",
		);
	}
	return lines.join("\n");
}

/** Gateway 总览 → Markdown。 */
export function renderOverview(overview: AdminOverview, recentAuditLimit?: number): string {
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

	return lines.join("\n");
}

/** 单次检索的审计明细 → Markdown。 */
export function renderAudit(record: AuditRecord): string {
	const lines = [
		`审计 ${record.requestId} · status=${record.status}`,
		`- traceId: ${record.traceId}`,
		`- query: ${record.request.query}`,
	];
	if (record.request.sources?.length) lines.push(`- sources: ${record.request.sources.join(", ")}`);
	if (record.request.route) lines.push(`- route: ${record.request.route}`);
	if (record.request.limit !== undefined) lines.push(`- limit: ${record.request.limit}`);
	lines.push(`- 开始: ${new Date(record.createdAt).toISOString()}（${formatAge(record.createdAt)}）`);
	if (record.completedAt !== undefined) {
		lines.push(
			`- 完成: ${new Date(record.completedAt).toISOString()} · 耗时 ${record.completedAt - record.createdAt}ms`,
		);
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
