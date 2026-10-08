import type { PluginConfig } from "./types.js";

/** Aylens Gateway 的错误语义（对齐 docs/api.md 的 error.code）。 */
export type AylensErrorCode =
	| "CONFIG_ERROR"
	| "AUTH_LOGIN_DISABLED"
	| "GATEWAY_UNREACHABLE"
	| "TIMEOUT"
	| "AUTH_FAILED"
	| "INVALID_REQUEST"
	| "NOT_FOUND"
	| "NO_RUNTIME"
	| "GATEWAY_ERROR";

export class AylensBridgeError extends Error {
	readonly code: AylensErrorCode;
	readonly status: number | undefined;

	constructor(code: AylensErrorCode, message: string, status?: number) {
		super(message);
		this.name = "AylensBridgeError";
		this.code = code;
		this.status = status;
	}
}

interface RequestOptions {
	method: "GET" | "POST";
	path: string;
	body?: unknown;
	query?: Record<string, string>;
}

function statusToCode(status: number): AylensErrorCode {
	if (status === 401 || status === 403) return "AUTH_FAILED";
	if (status === 404) return "NOT_FOUND";
	if (status >= 500) return "GATEWAY_ERROR";
	return "INVALID_REQUEST";
}

function extractGatewayMessage(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const error = (payload as { error?: unknown }).error;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return undefined;
}

/**
 * Aylens Gateway 的极简 REST 客户端。
 * 只用 Node 内置 fetch，零 npm 运行时依赖。
 */
export class AylensClient {
	readonly config: PluginConfig;

	constructor(config: PluginConfig) {
		this.config = config;
	}

	async request<T>(options: RequestOptions): Promise<T> {
		let url: URL;
		try {
			url = new URL(`${this.config.baseUrl}${options.path}`);
		} catch {
			throw new AylensBridgeError(
				"INVALID_REQUEST",
				`拼接出的请求地址非法：${this.config.baseUrl}${options.path}`,
			);
		}
		for (const [key, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(key, value);
		}

		const init: RequestInit = {
			method: options.method,
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(this.config.requestTimeoutMs),
		};

		if (options.body !== undefined) {
			init.headers = { ...init.headers, "Content-Type": "application/json" };
			init.body = JSON.stringify(options.body);
		}

		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			if (name === "TimeoutError" || name === "AbortError") {
				throw new AylensBridgeError(
					"TIMEOUT",
					`请求 Aylens Gateway 超时（${this.config.requestTimeoutMs}ms）：${options.method} ${options.path}。若命中浏览器兜底，请调大 config.env 的 REQUEST_TIMEOUT_MS。`,
				);
			}
			throw new AylensBridgeError(
				"GATEWAY_UNREACHABLE",
				`无法连接 Aylens Gateway（${this.config.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const raw = await response.text();
		let payload: unknown;
		if (raw.trim()) {
			try {
				payload = JSON.parse(raw);
			} catch {
				payload = undefined;
			}
		}

		if (!response.ok) {
			const detail = extractGatewayMessage(payload) ?? raw.slice(0, 300).trim();
			throw new AylensBridgeError(
				statusToCode(response.status),
				`Aylens Gateway 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`,
				response.status,
			);
		}

		if (payload === undefined) {
			throw new AylensBridgeError(
				"GATEWAY_ERROR",
				`Aylens Gateway 返回了非 JSON 响应：${raw.slice(0, 200)}`,
			);
		}

		return payload as T;
	}

	get<T>(path: string, query?: Record<string, string>): Promise<T> {
		return this.request<T>(query ? { method: "GET", path, query } : { method: "GET", path });
	}

	post<T>(path: string, body?: unknown): Promise<T> {
		return body === undefined
			? this.request<T>({ method: "POST", path })
			: this.request<T>({ method: "POST", path, body });
	}
}
