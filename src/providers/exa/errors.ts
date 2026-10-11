import { RetrievalError } from "../../core/errors.js";
import { ApiJsonClient } from "../../api-client/json-client.js";
import type { ExtractItemError } from "../../contracts/extract.js";
import type { CredentialFailure } from "../../runner/credentials/types.js";

/**
 * 把 Exa HTTP 状态映射为凭据失败分类。
 *
 * Exa 官方文档把 402 定义为「账号 credits 用尽**或**某把 Key 的预算超限」，
 * 把 429 定义为「Key、Team 或网络超出速率/并发限制」—— 两者都无法从响应本身区分。
 * 因此沿用 Tavily 432/429 的既有判例：范围不明时**只隔离当前 Key**，由同组其他
 * Key 各自上报，不拿模糊信息去封整个账号组（ADR-2026-10-09：额度错误范围未知时
 * 不能猜测，也不能把整个池永久禁用）。
 *
 * 后果是有界的：若上游其实是 Team 级额度耗尽或共享限流，池内每把 Key 各失败一次
 * 后就会收敛为全部阻断，不会无限轮换。
 *
 * 只看状态码与 Retry-After，**不解析响应 message**：上游文案不稳定，也可能含敏感内容。
 */
export function classifyExaFailure(
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
      // 能力未开通或账号状态异常不等于 Key 失效。
      return { category: "permission", scope: "unknown" };
    case 402:
      // 账号余额与 Key 预算不可区分：只隔离当前 Key。
      return { category: "quota", scope: "credential" };
    case 429:
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
export function toExaRetrievalError(status: number, _headers: Headers): RetrievalError {
  switch (status) {
    case 400:
    case 422:
      return new RetrievalError("INVALID_REQUEST", "Exa rejected the request as invalid", {
        retryable: false,
      });
    case 401:
      return new RetrievalError("UPSTREAM_AUTH_FAILED", "Exa rejected the API key", {
        retryable: false,
      });
    case 403:
      return new RetrievalError("UPSTREAM_ERROR", "Exa denied the request", { retryable: false });
    case 402:
      // 额度问题不是瞬时抖动，重试不会变好。
      return new RetrievalError("PROVIDER_UNAVAILABLE", "Exa quota or plan limit reached", {
        retryable: false,
      });
    case 429:
      return new RetrievalError("RATE_LIMITED", "Exa rate-limited the request", { retryable: true });
    default:
      if (status >= 500) {
        return new RetrievalError("UPSTREAM_ERROR", "Exa service is unavailable", { retryable: true });
      }
      return new RetrievalError("UPSTREAM_ERROR", "Exa request failed", { retryable: false });
  }
}

/** 固定的逐项内容失败文案：不携带上游 error 原文。 */
export const CONTENT_UNAVAILABLE_MESSAGE = "Exa could not extract this URL";

/**
 * Exa `statuses[].error.tag` → 逐项安全错误。
 *
 * 只把官方枚举里的 tag 映射成本地固定文案与错误码；未知 tag 一律降级为
 * CONTENT_UNAVAILABLE，既不回显上游字符串，也不假装可重试。
 */
const ITEM_ERRORS: Record<string, ExtractItemError> = {
  CRAWL_TIMEOUT: { code: "TIMEOUT", message: "Exa timed out while fetching this URL", retryable: true },
  CRAWL_LIVECRAWL_TIMEOUT: { code: "TIMEOUT", message: "Exa timed out while fetching this URL", retryable: true },
  UNSUPPORTED_URL: { code: "INVALID_REQUEST", message: "Exa does not support this URL", retryable: false },
  CRAWL_NOT_FOUND: { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false },
  SOURCE_NOT_AVAILABLE: { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false },
  CRAWL_UNKNOWN_ERROR: { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false },
};

export function mapExaItemError(tag: unknown): ExtractItemError {
  if (typeof tag === "string") {
    const mapped = ITEM_ERRORS[tag];
    if (mapped) return mapped;
  }
  return { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false };
}
