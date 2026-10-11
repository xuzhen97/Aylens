import { RetrievalError } from "../../core/errors.js";
import type { ExtractItem, ExtractRequest, ProviderExtractResponse } from "../../contracts/extract.js";
import type { ProviderSearchResponse, SearchDocument, SearchRequest } from "../../contracts/search.js";
import type {
  ProviderContext,
  ProviderFactory,
  ProviderFactoryContext,
} from "../types.js";
import { ExaClient, readCostUsd } from "./client.js";
import { mapExtractResults, mapSearchResults } from "./mapping.js";
import { resolveExtractParams, resolveSearchParams } from "./params.js";

/**
 * Exa 官方 `POST /contents` 的原生批量上限。公共契约的 urls 上限同为 100，
 * 但批次上限属于服务商，仍然由适配器显式分批，不写死在公共层。
 */
const NATIVE_EXTRACT_BATCH = 100;

interface ExaSearchEnvelope {
  requestId?: unknown;
  results?: unknown;
  searchType?: unknown;
  costDollars?: unknown;
}

interface ExaContentsEnvelope {
  requestId?: unknown;
  results?: unknown;
  statuses?: unknown;
  costDollars?: unknown;
}

const DEFAULT_TRANSPORT_ID = "direct";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 仅接受记录形状的对象：上游把 results 写成别的类型时按空结果处理而不是崩掉。 */
function objectList(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 通用 `content.mode` 派生的 Contents 请求体。
 *
 * 只有调用方明确要正文才买内容：既有调用不会因此多产生上游费用。
 * 不给 `contents` 时 Exa 只返回元数据与高亮，这是最省的形态。
 */
function derivedContents(request: SearchRequest): Record<string, unknown> {
  const mode = request.content?.mode ?? "none";
  const maxChars = request.content?.maxChars;

  if (mode === "full") {
    return { text: maxChars !== undefined ? { maxCharacters: maxChars } : true };
  }
  if (mode === "summary") {
    return { summary: true };
  }
  return {};
}

/**
 * 该 Contents 请求体是否真的设了字符上限。
 * 只看**最终合并结果**（部署层 / 请求级都可能覆写 `text`），
 * 用来如实标注 contentScope 是 full 还是 truncated。
 */
function hasTextCap(contents: Record<string, unknown>): boolean {
  const text = contents.text;
  return isRecord(text) && typeof text.maxCharacters === "number";
}

function requestedFormatOf(content: { format?: "markdown" | "text" | undefined } | undefined): "markdown" | "text" {
  return content?.format === "markdown" ? "markdown" : "text";
}

export function createExaFactory(): ProviderFactory {
  return {
    type: "exa",
    // 刻意不声明 "usage"：Exa 没有面向普通 Key 的用量端点（用量在独立的
    // Team Management API，需额外 service key）。声明了就会让上层以为可查。
    capabilities: ["search", "extract"],

    create(id, config, context: ProviderFactoryContext) {
      // 没有凭据池就不能发请求：明确失败，绝不降级成匿名或无认证调用。
      if (!context.credentials) {
        throw new RetrievalError(
          "PROVIDER_UNAVAILABLE",
          `Exa provider requires a runner credential pool: ${id}`,
          { retryable: false },
        );
      }

      const transportId = config.transport?.primary ?? DEFAULT_TRANSPORT_ID;
      const transport = context.transports.get(transportId);
      const deploymentOptions = config.options ?? {};
      const client = new ExaClient(context.credentials, transport, { providerId: id });

      return {
        id,

        async search(providerContext: ProviderContext, request: SearchRequest): Promise<ProviderSearchResponse> {
          const resolved = resolveSearchParams(deploymentOptions, request.providerOptions);
          const requestedFullContent = request.content?.mode === "full";
          const requestedFormat = requestedFormatOf(request.content);
          // Exa 没有语言参数：request.language 由公共契约提供给各 Provider，
          // 此处无法表达。宁可忽略并文档化，也不能报错 —— 否则多源搜索
          // （sources: ["tavily", "exa"]）会被单个 Provider 拖死。
          const contents = { ...derivedContents(request), ...(resolved.contents ?? {}) };

          const body: Record<string, unknown> = {
            query: request.query,
            ...(request.limit !== undefined ? { numResults: request.limit } : {}),
            // 服务商专属选项在通用字段之后展开：显式选项优先于通用字段。
            ...resolved.params,
            ...(Object.keys(contents).length > 0 ? { contents } : {}),
          };

          const { envelope, requestId } = await client.call<ExaSearchEnvelope>(
            providerContext,
            "/search",
            body,
            "search",
          );
          const costUsd = readCostUsd(envelope);
          const searchType = asString(envelope.searchType);
          const fetchedAt = new Date().toISOString();

          const items: SearchDocument[] = mapSearchResults(
            objectList(envelope.results),
            {
              requestId: providerContext.requestId,
              runtimeId: providerContext.runtimeId,
              fetchedAt,
              ...(requestId !== undefined ? { serviceRequestId: requestId } : {}),
              ...(costUsd !== undefined ? { costUsd } : {}),
              ...(searchType !== undefined ? { searchType } : {}),
              requestedFullContent,
              textTruncated: hasTextCap(contents),
              requestedFormat,
            },
            { provider: id, requestId: providerContext.requestId },
          );

          return { items: items.slice(0, request.limit ?? items.length) };
        },

        async extract(providerContext: ProviderContext, request: ExtractRequest): Promise<ProviderExtractResponse> {
          const params = resolveExtractParams(deploymentOptions, request.providerOptions);
          const requestedFormat = requestedFormatOf(request.content);
          const maxChars = request.content?.maxChars;
          // Extract 的目的就是拿正文：默认 text: true；显式选项可覆写成对象或关闭。
          const contentsParams = { text: maxChars !== undefined ? { maxCharacters: maxChars } : true, ...params };
          const textTruncated = hasTextCap(contentsParams);

          const items: ExtractItem[] = [];

          let serviceFailure: unknown;
          // 至少有一个批次拿到响应，就不算服务级失败：保留已抓到的内容更重要。
          let anyBatchResponded = false;

          for (let batchStart = 0; batchStart < request.urls.length; batchStart += NATIVE_EXTRACT_BATCH) {
            const urls = request.urls.slice(batchStart, batchStart + NATIVE_EXTRACT_BATCH);
            try {
              const { envelope, requestId } = await client.call<ExaContentsEnvelope>(
                providerContext,
                "/contents",
                { urls, ...contentsParams },
                "contents",
              );
              anyBatchResponded = true;
              const costUsd = readCostUsd(envelope);

              items.push(...mapExtractResults(
                urls,
                objectList(envelope.results),
                objectList(envelope.statuses),
                {
                  requestId: providerContext.requestId,
                  runtimeId: providerContext.runtimeId,
                  fetchedAt: new Date().toISOString(),
                  ...(requestId !== undefined ? { serviceRequestId: requestId } : {}),
                  ...(costUsd !== undefined ? { costUsd } : {}),
                  textTruncated,
                  requestedFormat,
                  // 索引在整个请求范围内下移，避免跨批次索引碰撞。
                  indexOffset: batchStart,
                },
              ));
            } catch (error) {
              // 部分批次失败时保留已抓到的内容：把这批 URL 标为失败，而不是丢弃全部。
              if (serviceFailure === undefined) serviceFailure = error;
              const itemError = toSafeItemError(error);
              items.push(...urls.map((url, offset) => ({
                index: batchStart + offset,
                url,
                status: "failed" as const,
                error: itemError,
              })));
            }
          }

          // 全部批次都以服务级错误失败时上抛，让 meta 与审计如实记录错误码；
          // 只要还有一批拿到响应就返回逐项结果，由 ExtractService 判定 partial。
          // （注意：这里不能用 items.length === 0 判定 —— 失败分支也会补逐项失败项。）
          if (!anyBatchResponded && serviceFailure !== undefined) throw serviceFailure;

          return { items: items.sort((a, b) => a.index - b.index) };
        },
      };
    },
  };
}

/** 逐项失败只用本地安全文案与错误码，不携带上游原文。 */
function toSafeItemError(error: unknown): ExtractItem["error"] {
  if (error instanceof RetrievalError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "CONTENT_UNAVAILABLE", message: "Exa could not extract this URL", retryable: false };
}

const exaFactory = createExaFactory();

export default {
  name: "aylens-exa",
  version: "1.0.0",
  factories: [exaFactory],
};

export { exaFactory };
