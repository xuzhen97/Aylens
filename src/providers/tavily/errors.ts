import { RetrievalError } from "../../core/errors.js";
import { ApiJsonClient } from "../../api-client/json-client.js";
import type { CredentialFailure } from "../../runner/credentials/types.js";

/**
 * 把 Tavily HTTP 状态映射为凭据失败分类。
 *
 * 只看状态码与 Retry-After，**不解析响应 message**：
 * 上游文案既不稳定，也可能包含敏感内容。范围(scope)决定能否换 Key，
 * 判错范围会把账号级限流当成 Key 失效去轮换，反而放大失败。
 */
export function classifyTavilyFailure(
  status: number,
  headers: Headers,
  _body: string,
): CredentialFailure | undefined {
  if (status >= 200 && status < 300) return undefined;

  const retryAfterMs = ApiJsonClient.parseRetryAfterMs(headers);

  switch (status) {
    case 400:
    case 422:
      return { category: "invalid_request", scope: "request" };
    case 401:
      return { category: "auth", scope: "credential" };
    case 403:
      // 403 可能是能力未开通或账号状态，不等同于 Key 失效。
      return { category: "permission", scope: "unknown" };
    case 429:
      return {
        category: "rate_limited",
        scope: "credential",
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    case 432:
      // 官方语义：Key 或套餐额度超限。无法区分时只隔离当前 Key，
      // 由同组其他 Key 各自上报，避免误伤整个账号。
      return { category: "quota", scope: "credential" };
    case 433:
      // PayGo 额度上限属于账号级：继续换 Key 一样被拒。
      return { category: "quota", scope: "account" };
    default:
      if (status >= 500) return { category: "upstream", scope: "service" };
      return { category: "upstream", scope: "unknown" };
  }
}

/**
 * 把状态码映射为对外错误码。消息一律本地生成，绝不回显上游响应体。
 */
export function toTavilyRetrievalError(status: number, headers: Headers): RetrievalError {
  const retryAfterMs = ApiJsonClient.parseRetryAfterMs(headers);

  switch (status) {
    case 400:
    case 422:
      return new RetrievalError("INVALID_REQUEST", "Tavily rejected the request as invalid", {
        retryable: false,
      });
    case 401:
      return new RetrievalError("UPSTREAM_AUTH_FAILED", "Tavily rejected the API key", {
        retryable: false,
      });
    case 403:
      return new RetrievalError("UPSTREAM_ERROR", "Tavily denied the request", { retryable: false });
    case 429:
      return new RetrievalError(
        "RATE_LIMITED",
        retryAfterMs !== undefined
          ? "Tavily rate-limited the request"
          : "Tavily rate-limited the request",
        { retryable: true },
      );
    case 432:
    case 433:
      // 额度问题不是瞬时抖动，重试不会变好，明确不可重试。
      return new RetrievalError("PROVIDER_UNAVAILABLE", "Tavily quota or plan limit reached", {
        retryable: false,
      });
    default:
      if (status >= 500) {
        return new RetrievalError("UPSTREAM_ERROR", "Tavily service is unavailable", { retryable: true });
      }
      return new RetrievalError("UPSTREAM_ERROR", "Tavily request failed", { retryable: false });
  }
}

/** 固定的逐项内容失败文案：不携带上游 failed_results.error 原文。 */
export const CONTENT_UNAVAILABLE_MESSAGE = "Tavily could not extract this URL";
