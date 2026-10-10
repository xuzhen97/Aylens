import { createHash } from "node:crypto";
import type { ExtractItem } from "../../contracts/extract.js";
import type { SearchDocument } from "../../contracts/search.js";
import { CONTENT_UNAVAILABLE_MESSAGE } from "./errors.js";

const DOCUMENT_ID_CHARS = 24;

/** 同一 URL 在不同 Provider 下应有不同 ID，避免跨 Provider 主键碰撞。 */
function documentId(url: string): string {
  return `tavily_${createHash("sha256").update(`tavily:${url}`).digest("hex").slice(0, DOCUMENT_ID_CHARS)}`;
}

interface TavilySearchResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  raw_content?: unknown;
  score?: unknown;
  published_date?: unknown;
  id?: unknown;
}

interface SearchMappingContext {
  requestId: string;
  runtimeId: string;
  fetchedAt: string;
  serviceRequestId?: string | undefined;
  usageCredits?: number | undefined;
  responseTimeMs?: number | undefined;
  /** 是否请求了原文；决定 contentScope 如实标注。 */
  requestedFullContent: boolean;
  /** 调用方要求的正文格式；text 格式不填 markdown 字段。 */
  format: "markdown" | "text";
}

/** 只读取认识的字段：上游多加的键不会被原样带进 SearchDocument。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 内容范围按**实际拿到的数据**标注，而不是按请求意图：
 * 想要全文但上游没给时，如实标 snippet，不能谎称 full。
 */
function contentScope(markdown: string | undefined, text: string | undefined): string {
  if (markdown !== undefined) return "full";
  if (text !== undefined) return "snippet";
  return "unknown";
}

export function mapSearchResults(
  results: TavilySearchResult[],
  context: SearchMappingContext,
  documentDefaults: { provider: string; requestId: string },
): SearchDocument[] {
  const fetchedAt = context.fetchedAt;

  return results.flatMap((result) => {
    const url = asString(result.url);
    if (url === undefined) return [];

    const rawContent = asString(result.raw_content);
    const snippet = asString(result.content);
    const text = rawContent ?? snippet;
    // text 格式不填 markdown：格式未知或调用方要纯文本时，不得把原文冒充 Markdown。
    const markdown = context.format === "text" ? undefined : rawContent;

    const extensions: Record<string, unknown> = {
      contentScope: contentScope(markdown, text),
    };
    if (context.serviceRequestId !== undefined) extensions.serviceRequestId = context.serviceRequestId;
    if (context.usageCredits !== undefined) extensions.usageCredits = context.usageCredits;
    if (context.responseTimeMs !== undefined) extensions.responseTimeMs = context.responseTimeMs;
    if (context.requestedFullContent && rawContent === undefined) {
      // 请求了原文但上游没给：显式标记，消费者不必自行猜。
      extensions.requestedFullContent = true;
      extensions.contentUnavailable = true;
    }

    return [{
      id: documentId(url),
      platform: "web",
      type: "webpage",
      url,
      ...(asString(result.title) !== undefined ? { title: asString(result.title) } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(markdown !== undefined ? { markdown } : {}),
      ...(asString(result.published_date) !== undefined ? { publishedAt: asString(result.published_date) } : {}),
      retrievedAt: fetchedAt,
      ...(typeof result.score === "number" ? { score: result.score } : {}),
      provenance: {
        provider: documentDefaults.provider,
        retrievalMethod: "api_search",
        ...(asString(result.id) !== undefined ? { providerItemId: asString(result.id) } : {}),
        requestId: documentDefaults.requestId,
        fetchedAt,
        runtimeId: context.runtimeId,
      },
      extensions,
    }];
  });
}

interface TavilyExtractResult {
  url?: unknown;
  raw_content?: unknown;
  title?: unknown;
}

interface TavilyFailedResult {
  url?: unknown;
  error?: unknown;
}

/**
 * 把 Extract 响应按**输入索引**对齐。
 *
 * 上游响应顺序不可信，且可能只回 failed_results 或只回 results ——
 * 输入中两边都没出现的 URL 必须显式判为失败，不能悄悄消失。
 */
export function mapExtractResults(
  inputs: string[],
  succeeded: TavilyExtractResult[],
  failed: TavilyFailedResult[],
  context: { requestId: string; runtimeId: string; fetchedAt: string; serviceRequestId?: string | undefined; usageCredits?: number | undefined },
  format: "markdown" | "text",
): ExtractItem[] {
  const successByUrl = new Map<string, TavilyExtractResult>();
  for (const entry of succeeded) {
    const url = asString(entry.url);
    if (url !== undefined) successByUrl.set(url, entry);
  }

  const failedUrls = new Set<string>();
  for (const entry of failed) {
    const url = asString(entry.url);
    if (url !== undefined) failedUrls.add(url);
  }

  return inputs.map((url, index) => {
    const success = successByUrl.get(url);
    if (success === undefined) {
      return {
        index,
        url,
        status: "failed",
        error: { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false },
      };
    }

    const rawContent = asString(success.raw_content) ?? "";
    const title = asString(success.title);
    const extensions: Record<string, unknown> = { contentScope: "full", extractFormat: format };
    if (context.serviceRequestId !== undefined) extensions.serviceRequestId = context.serviceRequestId;
    if (context.usageCredits !== undefined) extensions.usageCredits = context.usageCredits;

    const document: SearchDocument = {
      id: documentId(url),
      platform: "web",
      type: "webpage",
      url,
      ...(title !== undefined ? { title } : {}),
      text: rawContent,
      snippet: undefined,
      ...(format === "markdown" ? { markdown: rawContent } : {}),
      retrievedAt: context.fetchedAt,
      provenance: {
        provider: "tavily",
        retrievalMethod: "api_extract",
        requestId: context.requestId,
        fetchedAt: context.fetchedAt,
        runtimeId: context.runtimeId,
      },
      extensions,
    };

    return { index, url, status: "success", document };
  });
}
