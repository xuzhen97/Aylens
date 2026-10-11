import { createHash } from "node:crypto";
import type { ExtractItem } from "../../contracts/extract.js";
import type { SearchDocument } from "../../contracts/search.js";
import { mapExaItemError } from "./errors.js";

const DOCUMENT_ID_CHARS = 24;

/** 同一 URL 在不同 Provider 下应有不同 ID，避免跨 Provider 主键碰撞。 */
function documentId(url: string): string {
  return `exa_${createHash("sha256").update(`exa:${url}`).digest("hex").slice(0, DOCUMENT_ID_CHARS)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface ExaResult {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  author?: unknown;
  publishedDate?: unknown;
  score?: unknown;
  text?: unknown;
  highlights?: unknown;
  summary?: unknown;
  image?: unknown;
  favicon?: unknown;
}

interface ExaStatus {
  id?: unknown;
  /** 官方 statuses 用 `id` 回指 URL；这里容忍 `url` 形态。 */
  url?: unknown;
  status?: unknown;
  error?: unknown;
}

/**
 * 内容范围按**实际拿到的数据**标注，而不是按请求意图：
 * 要了全文但上游没给时如实标 snippet，不能谎称 full；
 * 我们自己设过字符上限时标 truncated —— 那是被截断的全文，不是完整全文。
 */
function contentScope(
  text: string | undefined,
  summary: string | undefined,
  highlights: string[] | undefined,
  textTruncated: boolean,
): string {
  if (text !== undefined) return textTruncated ? "truncated" : "full";
  if (summary !== undefined) return "summary";
  if (highlights !== undefined) return "snippet";
  return "unknown";
}

interface SearchMappingContext {
  requestId: string;
  runtimeId: string;
  fetchedAt: string;
  serviceRequestId?: string | undefined;
  costUsd?: number | undefined;
  searchType?: string | undefined;
  /** 调用方是否明确要了正文（content.mode = "full"）。 */
  requestedFullContent: boolean;
  /** 是否给上游设了字符上限。 */
  textTruncated: boolean;
  /** 调用方要求的格式。Exa 只返回纯文本，markdown 请求无法被满足。 */
  requestedFormat: "markdown" | "text";
}

/** 只读取认识的字段：上游多加的键不会被原样带进 SearchDocument。 */
function mapResult(result: ExaResult, context: SearchMappingContext, provider: string): SearchDocument | undefined {
  const url = asString(result.url);
  if (url === undefined) return undefined;

  const text = asString(result.text);
  const summary = asString(result.summary);
  const highlights = asStringArray(result.highlights);
  const author = asString(result.author);
  const image = asString(result.image);
  const favicon = asString(result.favicon);

  const extensions: Record<string, unknown> = {
    contentScope: contentScope(text, summary, highlights, context.textTruncated),
    // Exa 不产出 Markdown：如实标注实际拿到的格式，不假装满足 markdown 请求。
    contentFormat: "text",
  };
  if (context.requestedFormat === "markdown") extensions.requestedFormat = "markdown";
  if (context.serviceRequestId !== undefined) extensions.serviceRequestId = context.serviceRequestId;
  if (context.costUsd !== undefined) extensions.usageCostUsd = context.costUsd;
  if (context.searchType !== undefined) extensions.searchType = context.searchType;
  if (summary !== undefined) extensions.providerGeneratedSummary = summary;
  if (author !== undefined) extensions.author = author;
  if (image !== undefined) extensions.imageUrl = image;
  if (favicon !== undefined) extensions.faviconUrl = favicon;
  if (context.requestedFullContent && text === undefined) {
    // 请求了原文但上游没给：显式标记，消费者不必自行猜。
    extensions.requestedFullContent = true;
    extensions.contentUnavailable = true;
  }

  // snippet 语义是「短摘录」：优先用 Exa 生成摘要（对应 Tavily 的 content），
  // 其次用命中的高亮片段；两者都没有就不填，不拿全文冒充摘录。
  const snippet = summary ?? highlights?.join("\n");

  return {
    id: documentId(url),
    platform: "web",
    type: "webpage",
    url,
    ...(asString(result.title) !== undefined ? { title: asString(result.title) } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(asString(result.publishedDate) !== undefined ? { publishedAt: asString(result.publishedDate) } : {}),
    retrievedAt: context.fetchedAt,
    ...(asNumber(result.score) !== undefined ? { score: asNumber(result.score) } : {}),
    provenance: {
      provider,
      retrievalMethod: "api_search",
      ...(asString(result.id) !== undefined ? { providerItemId: asString(result.id) } : {}),
      requestId: context.requestId,
      fetchedAt: context.fetchedAt,
      runtimeId: context.runtimeId,
    },
    extensions,
  };
}

export function mapSearchResults(
  results: ExaResult[],
  context: SearchMappingContext,
  documentDefaults: { provider: string; requestId: string },
): SearchDocument[] {
  return results.flatMap((result) => {
    const document = mapResult(result, context, documentDefaults.provider);
    return document === undefined ? [] : [document];
  });
}

interface ExtractMappingContext {
  requestId: string;
  runtimeId: string;
  fetchedAt: string;
  serviceRequestId?: string | undefined;
  costUsd?: number | undefined;
  /** 是否给上游设了字符上限。 */
  textTruncated: boolean;
  /** 调用方要求的格式。Exa /contents 只返回纯文本。 */
  requestedFormat: "markdown" | "text";
  /**
   * 本次映射的输入在整个请求 URL 列表中的起始下标。
   *
   * 分批调用时上游只看到本批的 URL，若不下移索引，第二批次会从 0 重新计数，
   * 与上一批的索引碰撞 —— 公共层按索引归并，碰撞会导致内容错位与静默丢失。
   */
  indexOffset: number;
}

function statusErrorFor(status: ExaStatus | undefined): ExtractItem["error"] {
  if (status === undefined) return mapExaItemError(undefined);
  const error = status.error;
  const tag = error !== null && typeof error === "object" && !Array.isArray(error)
    ? (error as { tag?: unknown }).tag
    : undefined;
  return mapExaItemError(tag);
}

/**
 * 把 Contents 响应按**输入索引**对齐。
 *
 * Exa 用两个数组表达一次批量取正文：`results`（成功内容）与
 * `statuses`（逐 URL 成功/失败）。两边都可能漏项，因此：
 * 以 `results` 为准取内容，以 `statuses` 为准取失败原因，
 * 两边都没出现的 URL 显式判为失败 —— 不能悄悄消失。
 */
export function mapExtractResults(
  inputs: string[],
  results: ExaResult[],
  statuses: ExaStatus[],
  context: ExtractMappingContext,
): ExtractItem[] {
  const resultByUrl = new Map<string, ExaResult>();
  for (const entry of results) {
    const url = asString(entry.url) ?? asString(entry.id);
    if (url !== undefined && !resultByUrl.has(url)) resultByUrl.set(url, entry);
  }

  const statusByUrl = new Map<string, ExaStatus>();
  for (const entry of statuses) {
    const url = asString(entry.id) ?? asString(entry.url);
    if (url !== undefined && !statusByUrl.has(url)) statusByUrl.set(url, entry);
  }

  const items = inputs.map((url, offset): ExtractItem => {
    const index = context.indexOffset + offset;
    const result = resultByUrl.get(url);
    if (result === undefined) {
      return {
        index,
        url,
        status: "failed" as const,
        error: statusErrorFor(statusByUrl.get(url)),
      };
    }

    const text = asString(result.text) ?? "";
    const title = asString(result.title);
    const author = asString(result.author);
    const extensions: Record<string, unknown> = {
      contentScope: context.textTruncated ? "truncated" : "full",
      contentFormat: "text",
    };
    if (context.requestedFormat === "markdown") extensions.requestedFormat = "markdown";
    if (context.serviceRequestId !== undefined) extensions.serviceRequestId = context.serviceRequestId;
    if (context.costUsd !== undefined) extensions.usageCostUsd = context.costUsd;
    if (author !== undefined) extensions.author = author;

    const document: SearchDocument = {
      id: documentId(url),
      platform: "web",
      type: "webpage",
      url,
      ...(title !== undefined ? { title } : {}),
      text,
      ...(asString(result.publishedDate) !== undefined ? { publishedAt: asString(result.publishedDate) } : {}),
      retrievedAt: context.fetchedAt,
      provenance: {
        provider: "exa",
        retrievalMethod: "api_extract",
        ...(asString(result.id) !== undefined ? { providerItemId: asString(result.id) } : {}),
        requestId: context.requestId,
        fetchedAt: context.fetchedAt,
        runtimeId: context.runtimeId,
      },
      extensions,
    };

    return { index, url, status: "success" as const, document };
  });

  return items.sort((a, b) => a.index - b.index);
}
