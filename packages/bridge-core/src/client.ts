/** Aylens Gateway 的错误语义（对齐 docs/api.md 的 error.code）。 */
export type AylensErrorCode =
	| "CONFIG_ERROR"
	| "AUTH_LOGIN_DISABLED"
	| "GATEWAY_UNREACHABLE"
	| "TIMEOUT"
	| "ABORTED"
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

/** 两个宿主适配层共用的配置形状。 */
export interface BridgeConfig {
	baseUrl: string;
	apiKey: string;
	requestTimeoutMs: number;
	/** 是否允许在 Runner 上拉起可见 Chrome 做人工登录。默认 false。 */
	allowAuthLogin: boolean;
}

interface RequestOptions {
	method: "GET" | "POST";
	path: string;
	body?: unknown;
	query?: Record<string, string>;
	signal?: AbortSignal | undefined;
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
 *
 * `signal` 是给 DSH 侧用的：宿主要求每个异步工具都观测或转发 `exec.signal`。
 */
export class AylensClient {
	readonly config: BridgeConfig;

	constructor(config: BridgeConfig) {
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

		const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
		const signal =
			options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

		const init: RequestInit = {
			method: options.method,
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				Accept: "application/json",
			},
			signal,
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
				// 调用方取消与自身超时必须分开：前者不该让模型去调大 REQUEST_TIMEOUT_MS。
				if (options.signal?.aborted === true) {
					throw new AylensBridgeError(
						"ABORTED",
						`请求已被调用方取消：${options.method} ${options.path}`,
					);
				}
				throw new AylensBridgeError(
					"TIMEOUT",
					`请求 Aylens Gateway 超时（${this.config.requestTimeoutMs}ms）：` +
						`${options.method} ${options.path}。若命中浏览器兜底，请调大 REQUEST_TIMEOUT_MS。`,
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

	get<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<T> {
		return this.request<T>({
			method: "GET",
			path,
			...(query === undefined ? {} : { query }),
			...(signal === undefined ? {} : { signal }),
		});
	}

	post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		return this.request<T>({
			method: "POST",
			path,
			...(body === undefined ? {} : { body }),
			...(signal === undefined ? {} : { signal }),
		});
	}
}
