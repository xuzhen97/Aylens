import type { ExtractRequest } from "../contracts/extract.js";
import type { SearchRequest } from "../contracts/search.js";

const MAX_QUERY_LENGTH = 500;

/**
 * 把 URL 剥到 origin + path：移除 userinfo、query 与 fragment。
 * 不是合法 URL 时返回 undefined（调用方决定回退策略）。
 */
function sanitizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * 构造可持久化的安全请求副本:仅保留白名单字段。
 *
 * - HTTP(S) URL 查询:去除用户信息、全部查询参数与 fragment 后截断;
 * - 普通搜索词:直接截断到 500 字符。
 * 必须在写入任何存储之前调用;读取接口不允许恢复未保存的原始查询。
 */
export function toSafeRequest(request: SearchRequest): SearchRequest {
  let query = request.query.trim();

  try {
    const url = new URL(query);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      query = url.toString();
    }
  } catch {
    // 普通搜索词，按原样截断。
  }

  return {
    query: query.slice(0, MAX_QUERY_LENGTH),
    ...(request.route !== undefined ? { route: request.route } : {}),
    ...(request.sources !== undefined ? { sources: [...request.sources] } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.language !== undefined ? { language: request.language } : {}),
  };
}

/**
 * Extract 请求的安全摘要。
 *
 * 审计只保留前若干 URL 的 origin + path：查询参数可能携带凭据（签名、token），
 * fragment 也可能包含敏感状态，两者都必须在落库前移除。
 * 形状仍为 SearchRequest，以免让既有的审计读取方、Admin UI 与接口字段全部改动；
 * “这是一次提取”由 AuditRecord.operation 显式表达，不靠 query 猜测。
 */
export function toSafeExtractRequest(request: ExtractRequest): SearchRequest {
  const sanitized = request.urls
    .map((url) => sanitizeUrl(url) ?? url)
    .map((url) => url.slice(0, MAX_QUERY_LENGTH));

  return {
    // 拼接后再截断：单条 URL 不得挤占整个摘要预算。
    query: sanitized.join(" ").slice(0, MAX_QUERY_LENGTH),
    ...(request.sources !== undefined ? { sources: [...request.sources] } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  };
}
