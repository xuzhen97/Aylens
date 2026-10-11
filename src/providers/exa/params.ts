import { RetrievalError } from "../../core/errors.js";

/**
 * Exa 支持的请求级专属选项（Search）。
 *
 * 只白名单放行：调用方传了不认识的键必须明确报错，不能静默忽略。
 * 刻意**不放行**几类键：
 * - `livecrawl` / `livecrawlTimeout`：官方已弃用，应由 `maxAgeHours` 表达时效；
 * - `context`：已弃用；
 * - `outputSchema` / `additionalQueries`：deep search 专用，其产物是 `output`，
 *   而我们的契约会把它丢掉 —— 放行等于静默丢数据，不如直接报错。
 */
const ALLOWED_SEARCH_OPTIONS = new Set([
  "type",
  "category",
  "userLocation",
  "numResults",
  "includeDomains",
  "excludeDomains",
  "startCrawlDate",
  "endCrawlDate",
  "startPublishedDate",
  "endPublishedDate",
  "includeText",
  "excludeText",
  "moderation",
  "contents",
]);

/** Exa 支持的请求级专属选项（Contents / Extract）。 */
const ALLOWED_EXTRACT_OPTIONS = new Set([
  "text",
  "summary",
  "highlights",
  "maxAgeHours",
]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
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
      `Unsupported Exa ${source === "deployment" ? "deployment option" : "option"} for ${operation}`,
      { retryable: false },
    );
  }
}

function scopedOptions(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord | undefined {
  // 只取自己的命名空间：其他服务商的选项不得进入 Exa 请求体。
  return providerOptions?.exa;
}

/**
 * `contents` 必须是对象。
 * 上游也接受布尔简写，但布尔无法与「部署默认 / 请求覆盖」做字段级合并，
 * 因此这里只接受对象形态，让写错形状的调用方立刻看到错误。
 */
function asContentsRecord(value: unknown, source: "deployment" | "request"): UnknownRecord | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) {
    throw new RetrievalError(
      source === "deployment" ? "CONFIG_INVALID" : "INVALID_REQUEST",
      "Exa contents option must be an object",
      { retryable: false },
    );
  }
  return record;
}

/**
 * Search 专用选项解析。
 *
 * 优先级：通用 `content.mode` 派生值 < 部署层 `contents` < 请求级 `providerOptions.exa.contents`。
 * `contents` 单独返回而不是混进 params，就是为了让派生值能垫在部署层之下，
 * 而不是被顶层 `Object.assign` 整体覆盖掉。
 */
export function resolveSearchParams(
  deployment: UnknownRecord,
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): { params: UnknownRecord; contents: UnknownRecord | undefined } {
  const scoped = scopedOptions(providerOptions);
  assertKnownOptions("search", "deployment", ALLOWED_SEARCH_OPTIONS, deployment);
  if (scoped) assertKnownOptions("search", "request", ALLOWED_SEARCH_OPTIONS, scoped);

  const merged: UnknownRecord = { ...deployment, ...scoped };
  const contents: UnknownRecord = {
    ...asContentsRecord(deployment.contents, "deployment"),
    ...asContentsRecord(scoped?.contents, "request"),
  };
  delete merged.contents;

  return {
    params: merged,
    contents: Object.keys(contents).length > 0 ? contents : undefined,
  };
}

export function resolveExtractParams(
  deployment: UnknownRecord,
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): UnknownRecord {
  const scoped = scopedOptions(providerOptions);
  assertKnownOptions("extract", "deployment", ALLOWED_EXTRACT_OPTIONS, deployment);
  if (scoped) assertKnownOptions("extract", "request", ALLOWED_EXTRACT_OPTIONS, scoped);
  return { ...deployment, ...scoped };
}
