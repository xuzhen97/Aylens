import type { SearchRequest } from "../contracts/search.js";

const MAX_QUERY_LENGTH = 500;

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
    // 普通搜索词,按原样截断。
  }

  return {
    query: query.slice(0, MAX_QUERY_LENGTH),
    ...(request.route !== undefined ? { route: request.route } : {}),
    ...(request.sources !== undefined ? { sources: [...request.sources] } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.language !== undefined ? { language: request.language } : {}),
  };
}
