import { RetrievalError } from "../../core/errors.js";

/**
 * Tavily 支持的请求级专属选项。
 *
 * 只白名单放行：调用方传了不认识的键必须明确报错，不能静默忽略 ——
 * 否则“以为开了 advanced 实际没开”这类语义漂移无法被发现。
 */
const ALLOWED_SEARCH_OPTIONS = new Set([
  "search_depth",
  "topic",
  "include_answer",
  "include_raw_content",
  "include_usage",
  "auto_parameters",
  "include_domains",
  "exclude_domains",
  "time_range",
  "days",
  "language",
  "max_results",
]);

const ALLOWED_EXTRACT_OPTIONS = new Set([
  "extract_depth",
  "include_images",
  "format",
  "timeout",
]);

type UnknownRecord = Record<string, unknown>;

/**
 * 合并 Provider 部署默认值与请求级专属选项。
 * 请求级覆盖部署默认值；未知键抛 INVALID_REQUEST（固定文案，不回显输入）。
 */
function mergeOptions(
  operation: "search" | "extract",
  allowed: Set<string>,
  deployment: UnknownRecord,
  requestScoped: UnknownRecord | undefined,
): UnknownRecord {
  const merged: UnknownRecord = {};
  for (const [key, value] of Object.entries(deployment)) {
    if (!allowed.has(key)) {
      throw new RetrievalError(
        "CONFIG_INVALID",
        `Unsupported Tavily deployment option for ${operation}`,
        { retryable: false },
      );
    }
    merged[key] = value;
  }

  if (requestScoped) {
    for (const key of Object.keys(requestScoped)) {
      if (!allowed.has(key)) {
        throw new RetrievalError(
          "INVALID_REQUEST",
          `Unsupported Tavily option for ${operation}`,
          { retryable: false },
        );
      }
    }
    Object.assign(merged, requestScoped);
  }

  return merged;
}

function scoped(
  operation: "search" | "extract",
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord | undefined {
  if (!providerOptions) return undefined;
  // 只取自己的命名空间：其他服务商的选项不得进入 Tavily 请求体。
  return providerOptions.tavily !== undefined && operation === "search"
    ? providerOptions.tavily
    : providerOptions.tavily !== undefined && operation === "extract"
      ? providerOptions.tavily
      : undefined;
}

export function resolveSearchParams(
  deployment: UnknownRecord,
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord {
  return mergeOptions("search", ALLOWED_SEARCH_OPTIONS, deployment, scoped("search", providerOptions));
}

export function resolveExtractParams(
  deployment: UnknownRecord,
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord {
  return mergeOptions("extract", ALLOWED_EXTRACT_OPTIONS, deployment, scoped("extract", providerOptions));
}

/** 部署层配置的合法键（供启动校验复用，避免两处白名单漂移）。 */
export const TAVILY_DEPLOYMENT_OPTION_KEYS = {
  search: ALLOWED_SEARCH_OPTIONS,
  extract: ALLOWED_EXTRACT_OPTIONS,
} as const;
