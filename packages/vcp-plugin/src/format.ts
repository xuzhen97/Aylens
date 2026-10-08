import { AylensBridgeError } from "./client.js";
import type { VcpResponse } from "./types.js";

/**
 * 本地镜像 Aylens 的检索契约（src/contracts/search.ts）。
 * 刻意不从 Aylens 源码 import：插件是独立分发的单文件产物，必须自洽。
 */
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

/** 单篇文档的正文上限（字符）。 */
const MAX_DOC_BODY_CHARS = 4_000;
/** 整次返回的正文总上限（字符）。VCP 上下文不是无限预算。 */
const MAX_TOTAL_BODY_CHARS = 28_000;
/** snippet / text 摘要上限。 */
const MAX_SNIPPET_CHARS = 600;

export function ok(text: string, messageForAI?: string): VcpResponse {
	const content = [{ type: "text" as const, text }];
	return messageForAI === undefined
		? { status: "success", result: { content }, content }
		: { status: "success", result: { content, messageForAI }, content, messageForAI };
}

export function fail(error: unknown): VcpResponse {
	const code = error instanceof AylensBridgeError ? error.code : "UNKNOWN";
	const message = error instanceof Error ? error.message : String(error);
	const text = `[AylensBridge:${code}] ${message}`;
	return {
		status: "error",
		error: message,
		result: { content: [{ type: "text", text }], messageForAI: text },
		content: [{ type: "text", text }],
		messageForAI: text,
	};
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

/**
 * 把 Aylens 的 SearchResponse 渲染成给 AI 读的 Markdown。
 * 不转义任何文档正文——Markdown 是 Aylens 的正式契约（ADR: search-document-markdown-contract）。
 */
export function formatSearchResponse(response: SearchResponse): string {
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
