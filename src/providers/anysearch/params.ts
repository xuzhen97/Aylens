import { RetrievalError } from "../../core/errors.js";

/**
 * AnySearch **Search** 支持的请求级专属选项。
 *
 * 只白名单放行：调用方传了不认识的键必须明确报错，不能静默忽略。
 */
const ALLOWED_SEARCH_OPTIONS = new Set([
  "tag",
  "zone",
  "language",
  "params",
  "format",
  "max_results",
]);

/**
 * AnySearch **Extract** 的请求级白名单是**空集**。
 *
 * 官方要求 `/v1/extract` 的 body 是「恰好一个对象、恰好一个非空字符串 url」，
 * 出现未知字段或重复字段即被拒（400）。因此这里没有任何可放行的键：
 * 传任何专属选项都明确报错，而不是发出去被上游打回。
 */
const ALLOWED_EXTRACT_OPTIONS = new Set<string>([]);

/**
 * 适配器级（**不发往上游**）的部署选项。
 *
 * 与上游参数分开维护：这些键必须从部署 options 里摘掉再送去校验，
 * 否则它们会漏进请求体，被上游当成未知字段拒绝。
 */
const ADAPTER_OPTION_KEYS = new Set([
  "maxConcurrentExtracts",
]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

/**
 * 把部署 options 拆成「适配器自用」与「上游参数」两部分。
 * 上游参数里若还留着适配器键，会在下面的白名单校验里被明确拒绝。
 */
export function splitDeploymentOptions(deployment: UnknownRecord): {
  adapter: UnknownRecord;
  upstream: UnknownRecord;
} {
  const adapter: UnknownRecord = {};
  const upstream: UnknownRecord = {};
  for (const [key, value] of Object.entries(deployment)) {
    if (ADAPTER_OPTION_KEYS.has(key)) adapter[key] = value;
    else upstream[key] = value;
  }
  return { adapter, upstream };
}

/** 未知键明确报错；部署层是配置错误，请求层是请求错误，两者错误码不同。 */
function assertKnownOptions(
  operation: "search" | "extract",
  source: "deployment" | "request",
  allowed: Set<string>,
  options: UnknownRecord,
): void {
  for (const key of Object.keys(options)) {
    if (allowed.has(key)) continue;
    throw new RetrievalError(
      source === "deployment" ? "CONFIG_INVALID" : "INVALID_REQUEST",
      `Unsupported AnySearch ${source === "deployment" ? "deployment option" : "option"} for ${operation}`,
      { retryable: false },
    );
  }
}

function scopedOptions(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord | undefined {
  // 只取自己的命名空间：其他服务商的选项不得进入 AnySearch 请求体。
  return providerOptions?.anysearch;
}

/** 合并部署默认值与请求级专属选项：请求级覆盖部署层。 */
export function resolveSearchParams(
  deployment: UnknownRecord,
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord {
  const scoped = scopedOptions(providerOptions);
  assertKnownOptions("search", "deployment", ALLOWED_SEARCH_OPTIONS, deployment);
  if (scoped) assertKnownOptions("search", "request", ALLOWED_SEARCH_OPTIONS, scoped);
  return { ...deployment, ...scoped };
}

/**
 * Extract 没有任何可放行的选项：部署层与请求层都必须为空。
 */
export function resolveExtractParams(
  deployment: UnknownRecord,
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord {
  const scoped = scopedOptions(providerOptions);
  assertKnownOptions("extract", "deployment", ALLOWED_EXTRACT_OPTIONS, deployment);
  if (scoped) assertKnownOptions("extract", "request", ALLOWED_EXTRACT_OPTIONS, scoped);
  return {};
}

/** 逐 URL 提取的并发上限：默认保守，可被部署选项覆盖（见 index.ts 的校验）。 */
export const DEFAULT_MAX_CONCURRENT_EXTRACTS = 2;
export const MAX_CONCURRENT_EXTRACTS_LIMIT = 8;

/**
 * 解析并校验适配器级并发选项。
 *
 * 上游按 Key / IP 限流（免费档量级为 20 QPS），而单 URL 提取意味着 100 个 URL
 * 要发 100 次请求 —— 不设上限会自己把自己打成限流。
 */
export function resolveMaxConcurrentExtracts(adapter: UnknownRecord): number {
  const value = adapter.maxConcurrentExtracts;
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_EXTRACTS;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_CONCURRENT_EXTRACTS_LIMIT
  ) {
    throw new RetrievalError(
      "CONFIG_INVALID",
      `AnySearch maxConcurrentExtracts must be an integer between 1 and ${MAX_CONCURRENT_EXTRACTS_LIMIT}`,
      { retryable: false },
    );
  }
  return value;
}

export { asRecord };
