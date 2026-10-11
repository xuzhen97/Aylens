import { RetrievalError } from "../../core/errors.js";
import { ApiJsonClient } from "../../api-client/json-client.js";
import type { ExtractItemError } from "../../contracts/extract.js";
import type { CredentialFailure } from "../../runner/credentials/types.js";

/**
 * 错误策略按**端点**区分：同一个状态码在 Search 与 Extract 下语义不同
 * （422 只在 Extract 出现，表示「这一个 URL 提取不了」，不是 Key 或服务的问题）。
 */
export type AnySearchOperation = "search" | "extract";

/**
 * 把 HTTP 状态映射为凭据失败分类。
 *
 * ⚠️ 只看状态码与 Retry-After，**绝不解析 message**：AnySearch 在匿名额度耗尽时
 * 会把自动注册生成的 username / password / api_key 放进 402 的 message 里，
 * 官方明确要求整包按敏感数据处理。我们不读、不回显、不落日志或审计。
 *
 * 我们永不发匿名请求（官方 401 语义也是「无效凭据不回退匿名」），
 * 因此 402 只可能来自 Key / 账号额度，按 credential 范围隔离当前 Key。
 */
export function classifyAnySearchFailure(
  operation: AnySearchOperation,
  status: number,
  headers: Headers,
  _body: string,
): CredentialFailure | undefined {
  if (status >= 200 && status < 300) return undefined;

  const retryAfterMs = ApiJsonClient.parseRetryAfterMs(headers);

  switch (status) {
    case 400:
    case 415:
      // 415：Content-Type 缺失或不是 application/json —— 这是我们自己的请求问题，
      // 与 Key 无关（公共执行机制始终发送 application/json）。
      return { category: "invalid_request", scope: "request" };
    case 401:
      return { category: "auth", scope: "credential" };
    case 402:
      return { category: "quota", scope: "credential" };
    case 403:
      // Key 过期 / 账号被禁用 / 禁止访问，不等于 Key 无效。
      return { category: "permission", scope: "unknown" };
    case 422:
      if (operation === "extract") {
        // 逐 URL 提取失败：不能因此把 Key 标坏。
        return { category: "item_content", scope: "request" };
      }
      return { category: "invalid_request", scope: "request" };
    case 429:
      // 官方未承诺 Retry-After；没有就只记录类别，不猜冷却时长。
      return {
        category: "rate_limited",
        scope: "credential",
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    default:
      if (status >= 500) return { category: "upstream", scope: "service" };
      return { category: "upstream", scope: "unknown" };
  }
}

/** 把状态码映射为对外错误码。消息一律本地生成，绝不回显上游响应体。 */
export function toAnySearchRetrievalError(
  operation: AnySearchOperation,
  status: number,
  _headers: Headers,
): RetrievalError {
  switch (status) {
    case 400:
    case 415:
      return new RetrievalError("INVALID_REQUEST", "AnySearch rejected the request as invalid", {
        retryable: false,
      });
    case 401:
      return new RetrievalError("UPSTREAM_AUTH_FAILED", "AnySearch rejected the API key", {
        retryable: false,
      });
    case 402:
      return new RetrievalError("PROVIDER_UNAVAILABLE", "AnySearch quota or plan limit reached", {
        retryable: false,
      });
    case 403:
      return new RetrievalError("UPSTREAM_ERROR", "AnySearch denied the request", { retryable: false });
    case 422:
      return operation === "extract"
        ? new RetrievalError("CONTENT_UNAVAILABLE", CONTENT_UNAVAILABLE_MESSAGE, { retryable: false })
        : new RetrievalError("INVALID_REQUEST", "AnySearch rejected the request as invalid", {
          retryable: false,
        });
    case 429:
      return new RetrievalError("RATE_LIMITED", "AnySearch rate-limited the request", { retryable: true });
    default:
      if (status >= 500) {
        return new RetrievalError("UPSTREAM_ERROR", "AnySearch service is unavailable", { retryable: true });
      }
      return new RetrievalError("UPSTREAM_ERROR", "AnySearch request failed", { retryable: false });
  }
}

/**
 * HTTP 200 但业务码非 0 的情况。
 *
 * 官方只承诺「成功是 0、错误可能是 -1，且可能带稳定 error_code」，并明确提醒
 * 「不要假设每个错误都用 code: -1」。因此这里只认**有依据**的数值：
 * - `42901`：公开文档与官方 MCP 实现都当作限流；
 * - 与 HTTP 状态同形的业务码（400/401/402/403/422/429）。
 * 其余未知业务码一律不猜：只落 upstream/unknown，不做凭据判定，
 * 也不因一个陌生数字把 Key 隔离掉。
 */
const BUSINESS_CODE_TO_STATUS: Record<number, number> = {
  400: 400,
  401: 401,
  402: 402,
  403: 403,
  422: 422,
  429: 429,
  42901: 429,
};

export function businessStatusOf(code: number): number | undefined {
  return BUSINESS_CODE_TO_STATUS[code];
}

/**
 * 业务码失败的对外错误。只按数值映射，message 一律不读。
 */
export function toAnySearchBusinessError(operation: AnySearchOperation, code: number): RetrievalError {
  const status = businessStatusOf(code);
  if (status === undefined) {
    return new RetrievalError("UPSTREAM_ERROR", "AnySearch returned an unsuccessful result code", {
      retryable: false,
    });
  }
  return toAnySearchRetrievalError(operation, status, new Headers());
}

/** 固定的逐项内容失败文案：不携带上游 message 原文。 */
export const CONTENT_UNAVAILABLE_MESSAGE = "AnySearch could not extract this URL";

/** 逐项失败只用本地安全文案；上游 error_code 只用于在已知枚举内挑文案。 */
const ITEM_ERRORS: Record<string, ExtractItemError> = {
  invalid_extract_url: { code: "INVALID_REQUEST", message: "AnySearch rejected this URL", retryable: false },
  extract_failed: { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false },
};

export function mapAnySearchItemError(errorCode: unknown): ExtractItemError {
  if (typeof errorCode === "string") {
    const mapped = ITEM_ERRORS[errorCode];
    if (mapped) return mapped;
  }
  return { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false };
}
