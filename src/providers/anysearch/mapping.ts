import { createHash } from "node:crypto";
import type { ExtractItem } from "../../contracts/extract.js";
import type { SearchDocument } from "../../contracts/search.js";

const DOCUMENT_ID_CHARS = 24;

/** 同一 URL 在不同 Provider 下应有不同 ID，避免跨 Provider 主键碰撞。 */
function documentId(url: string): string {
  return `anysearch_${createHash("sha256").update(`anysearch:${url}`).digest("hex").slice(0, DOCUMENT_ID_CHARS)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface SearchMappingContext {
  requestId: string;
  runtimeId: string;
  fetchedAt: string;
  serviceRequestId?: string | undefined;
  /** 上游自报的搜索耗时（`data.metadata.search_time_ms`）。 */
  searchTimeMs?: number | undefined;
  /** 调用方是否明确要了正文（content.mode = "full"）。 */
  requestedFullContent: boolean;
  /** 通用 content.mode 要了 summary：AnySearch 没有对应参数，如实标注而不是假装照办。 */
  requestedSummary: boolean;
  /** 调用方要求 Markdown，且已按此请求上游（format: markdown → content 就是 Markdown）。 */
  markdownRequested: boolean;
  /** limit 超过上游上限时，如实记录「想要多少、实际用了多少」。 */
  limitCapped?: { requested: number; applied: number } | undefined;
}

/**
 * 内容范围按**实际拿到的数据**标注。
 *
 * ⚠️ AnySearch 的 search 只承诺 `content` 是「cleaned result content」，
 * **不承诺是全文**（官方建议需要整页时改用 extract），因此拿到 content 时
 * 标 `partial` —— 不谎称 full。没有 content 只有 snippet 时标 snippet。
 */
function contentScope(content: string | undefined, snippet: string | undefined): string {
  if (content !== undefined) return "partial";
  if (snippet !== undefined) return "snippet";
  return "unknown";
}

export function mapSearchResults(
  results: Array<Record<string, unknown>>,
  context: SearchMappingContext,
  documentDefaults: { provider: string; requestId: string },
): SearchDocument[] {
  return results.flatMap((result) => {
    const url = asString(result.url);
    if (url === undefined) return [];

    const title = asString(result.title);
    const content = asString(result.content);
    const snippet = asString(result.snippet);
    // format: markdown 时上游的 content 就是 Markdown，可以如实填充 markdown 字段。
    const markdown = context.markdownRequested ? content : undefined;

    const extensions: Record<string, unknown> = {
      contentScope: contentScope(content, snippet),
      contentFormat: context.markdownRequested ? "markdown" : "text",
    };
    if (context.serviceRequestId !== undefined) extensions.serviceRequestId = context.serviceRequestId;
    if (context.searchTimeMs !== undefined) extensions.responseTimeMs = context.searchTimeMs;
    if (context.requestedSummary) extensions.requestedContentMode = "summary";
    if (context.limitCapped !== undefined) {
      extensions.requestedLimit = context.limitCapped.requested;
      extensions.limitCappedTo = context.limitCapped.applied;
    }
    if (context.requestedFullContent && content === undefined) {
      // 请求了正文但上游没给：显式标记，消费者不必自行猜。
      extensions.requestedFullContent = true;
      extensions.contentUnavailable = true;
    }

    return [{
      id: documentId(url),
      platform: "web",
      type: "webpage",
      url,
      ...(title !== undefined ? { title } : {}),
      ...(content !== undefined ? { text: content } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(markdown !== undefined ? { markdown } : {}),
      retrievedAt: context.fetchedAt,
      provenance: {
        provider: documentDefaults.provider,
        retrievalMethod: "api_search",
        requestId: documentDefaults.requestId,
        fetchedAt: context.fetchedAt,
        runtimeId: context.runtimeId,
      },
      extensions,
    }];
  });
}

interface ExtractMappingContext {
  requestId: string;
  runtimeId: string;
  fetchedAt: string;
  serviceRequestId?: string | undefined;
}

/**
 * 把单个 URL 的 `/v1/extract` 结果映射成文档。
 *
 * 返回 undefined 表示这次调用没有可用正文（`data.content` 缺失或不是字符串）：
 * 由调用方判为逐项失败，而不是拿空文档冒充成功。
 * `content` 的格式官方不做保证（cleaned HTML / 纯文本 / JSON / Markdown 皆有可能），
 * 因此 **永不填 markdown 字段**，只填 text 并标注 contentFormat: unknown。
 */
export function mapExtractDocument(
  url: string,
  data: Record<string, unknown>,
  context: ExtractMappingContext,
): SearchDocument | undefined {
  const content = typeof data.content === "string" ? data.content : undefined;
  if (content === undefined) return undefined;

  const title = asString(data.title);

  return {
    id: documentId(url),
    platform: "web",
    type: "webpage",
    url,
    ...(title !== undefined ? { title } : {}),
    text: content,
    retrievedAt: context.fetchedAt,
    provenance: {
      provider: "anysearch",
      retrievalMethod: "api_extract",
      requestId: context.requestId,
      fetchedAt: context.fetchedAt,
      runtimeId: context.runtimeId,
    },
    extensions: {
      contentScope: "full",
      // 上游不保证正文格式；标 unknown 比猜 text 或 markdown 都诚实。
      contentFormat: "unknown",
      ...(context.serviceRequestId !== undefined ? { serviceRequestId: context.serviceRequestId } : {}),
    },
  };
}

export type { ExtractItem };
