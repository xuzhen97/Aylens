import { RetrievalError } from "../core/errors.js";
import type { HttpTransport } from "../transports/types.js";
import type { ApiCallRequest, ApiCallResult, ApiJsonClientOptions } from "./types.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 受控的上游 JSON 客户端。
 *
 * 安全边界：
 * - **只与配置的 origin 通信**：认证头永远不会发到别处；
 * - **不跟随重定向**：3xx 一律按上游错误处理，否则 Key 会随 Location 被重放到陌生站点；
 * - **限制响应体大小**：超限抛错而不是截断，避免把半截 JSON 当成完整结果。
 *
 * 错误消息一律是本地固定文案，不回显上游响应体或 URL ——
 * 上游 message 里可能带凭据（AnySearch 匿名额度耗尽时会生成并返回凭据）。
 */
export class ApiJsonClient {
  /** 构造时解析一次：非法 allowedOrigin 立即失败，不在每个请求上重复解析或抛错。 */
  private readonly allowedOrigin: string;

  constructor(
    private readonly transport: HttpTransport,
    private readonly options: ApiJsonClientOptions,
  ) {
    let parsed: URL;
    try {
      parsed = new URL(options.allowedOrigin);
    } catch {
      throw new RetrievalError(
        "INVALID_REQUEST",
        "ApiJsonClient allowedOrigin is not a valid URL",
        { retryable: false },
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new RetrievalError(
        "INVALID_REQUEST",
        "ApiJsonClient allowedOrigin must use http(s)",
        { retryable: false },
      );
    }
    this.allowedOrigin = parsed.origin;
  }

  async send(request: ApiCallRequest): Promise<ApiCallResult> {
    const url = this.parseAndCheckOrigin(request.url);

    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

    const response = await this.transport.request({
      url: url.toString(),
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal,
    });

    // 不跟随重定向：认证头不得离开受信 origin。
    if (response.status >= 300 && response.status < 400) {
      throw new RetrievalError(
        "UPSTREAM_ERROR",
        "Upstream responded with a redirect, which is not followed",
        { retryable: false },
      );
    }

    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (response.body.length > maxBytes) {
      // 固定文案：绝不把响应体片段带进错误消息。
      throw new RetrievalError(
        "UPSTREAM_ERROR",
        "Upstream response exceeded the size limit",
        { retryable: false },
      );
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      requestId: response.headers.get("x-request-id") ?? response.headers.get("x-requestid") ?? undefined,
    };
  }

  private parseAndCheckOrigin(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // 不回显原值：查询参数里可能带敏感信息。
      throw new RetrievalError("URL_FORBIDDEN", "Upstream request URL is invalid", { retryable: false });
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new RetrievalError("URL_FORBIDDEN", "Upstream request URL protocol is not allowed", { retryable: false });
    }

    if (url.origin !== this.allowedOrigin) {
      throw new RetrievalError(
        "URL_FORBIDDEN",
        "Upstream request target is outside the configured origin",
        { retryable: false },
      );
    }

    // 受信 origin 也不接受带凭据的 URL：认证只走显式 header。
    if (url.username || url.password) {
      throw new RetrievalError("URL_FORBIDDEN", "Upstream request URL must not embed credentials", { retryable: false });
    }

    return url;
  }

  /**
   * 解析 Retry-After：秒数或 HTTP 日期。
   * 合法值换算为毫秒；无法解析或已过期时返回 undefined —— 调用方退避到默认策略，不猜固定值。
   */
  static parseRetryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
    const raw = headers.get("retry-after");
    if (!raw) return undefined;

    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (!Number.isFinite(seconds)) return undefined;
      return seconds * 1_000;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return undefined;
    const delta = parsed - now;
    return delta > 0 ? delta : undefined;
  }
}
