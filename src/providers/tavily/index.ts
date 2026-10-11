import { RetrievalError } from "../../core/errors.js";
import type { ExtractRequest, ExtractItem, ProviderExtractResponse } from "../../contracts/extract.js";
import type { ProviderSearchResponse, SearchDocument, SearchRequest } from "../../contracts/search.js";
import type {
  ProviderContext,
  ProviderFactory,
  ProviderFactoryContext,
  ProviderUsageReport,
} from "../types.js";
import { TavilyClient, readUsage } from "./client.js";
import { mapExtractResults, mapSearchResults } from "./mapping.js";
import { resolveExtractParams, resolveSearchParams } from "./params.js";

/**
 * Tavily 官方 API 原生的提取批大小上限。超出必须自行分批，
 * 不假设每个服务商的批次限制都一样。
 */
const NATIVE_EXTRACT_BATCH = 20;

interface TavilySearchEnvelope {
  request_id?: unknown;
  response_time?: unknown;
  results?: unknown;
  usage?: { credits?: unknown };
}

interface TavilyExtractEnvelope {
  request_id?: unknown;
  response_time?: unknown;
  results?: unknown;
  failed_results?: unknown;
  usage?: { credits?: unknown };
}

interface TavilyUsageEnvelope {
  request_id?: unknown;
  response_time?: unknown;
  key?: { usage?: unknown; limit?: unknown };
  account?: { usage?: unknown; plan_limit?: unknown };
}

const DEFAULT_TRANSPORT_ID = "direct";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 仅接受记录形状的对象；上游把 results 写成别的类型时按空结果处理而不是崩掉。 */
function objectList(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry));
}

/** 内容格式：只认两个可选字段，Search 与 Extract 共用同一形状。 */
function contentFormatOf(request: {
  content?: { format?: "markdown" | "text" | undefined } | undefined;
}): "markdown" | "text" {
  return request.content?.format === "text" ? "text" : "markdown";
}

export function createTavilyFactory(): ProviderFactory {
  return {
    type: "tavily",
    capabilities: ["search", "extract", "usage"],

    create(id, config, context: ProviderFactoryContext) {
      // 没有凭据池就不能发请求：明确失败，绝不降级成匿名或无认证调用。
      if (!context.credentials) {
        throw new RetrievalError(
          "PROVIDER_UNAVAILABLE",
          `Tavily provider requires a runner credential pool: ${id}`,
          { retryable: false },
        );
      }

      const transportId = config.transport?.primary ?? DEFAULT_TRANSPORT_ID;
      const transport = context.transports.get(transportId);
      const deploymentOptions = config.options ?? {};
      const client = new TavilyClient(context.credentials, transport, {
        providerId: id,
        deploymentOptions,
      });

      const provider = {
        id,

        async search(providerContext: ProviderContext, request: SearchRequest): Promise<ProviderSearchResponse> {
          const params = resolveSearchParams(deploymentOptions, request.providerOptions);
          const requestedFullContent = request.content?.mode === "full";
          const format = contentFormatOf(request);

          const body: Record<string, unknown> = {
            query: request.query,
            ...(request.limit !== undefined ? { max_results: request.limit } : {}),
            ...(request.language !== undefined ? { language: request.language } : {}),
            // 只有调用方明确要正文才买原文：既有调用不隐式增加费用。
            ...(requestedFullContent ? { include_raw_content: true } : {}),
            ...params,
          };

          const { envelope, requestId } = await client.call<TavilySearchEnvelope>(
            providerContext,
            "/search",
            body,
            "search",
          );
          const usage = readUsage(envelope);
          const fetchedAt = new Date().toISOString();

          const items: SearchDocument[] = mapSearchResults(
            objectList(envelope.results) as Array<Record<string, unknown>>,
            {
              requestId: providerContext.requestId,
              runtimeId: providerContext.runtimeId,
              fetchedAt,
              serviceRequestId: requestId,
              usageCredits: usage.credits,
              ...(usage.responseTimeMs !== undefined ? { responseTimeMs: usage.responseTimeMs } : {}),
              requestedFullContent,
              format,
            },
            { provider: id, requestId: providerContext.requestId },
          );

          return { items: items.slice(0, request.limit ?? items.length) };
        },

        async extract(providerContext: ProviderContext, request: ExtractRequest): Promise<ProviderExtractResponse> {
          const params = resolveExtractParams(deploymentOptions, request.providerOptions);
          const format = contentFormatOf(request);
          const items: ExtractItem[] = [];

          let serviceFailure: unknown;
          // 至少有一个批次拿到响应，就不算服务级失败：保留已抓到的内容更重要。
          let anyBatchResponded = false;

          for (let batchStart = 0; batchStart < request.urls.length; batchStart += NATIVE_EXTRACT_BATCH) {
            const urls = request.urls.slice(batchStart, batchStart + NATIVE_EXTRACT_BATCH);
            try {
              const { envelope, requestId } = await client.call<TavilyExtractEnvelope>(
                providerContext,
                "/extract",
                { urls, format, ...params },
                "extract",
              );
              anyBatchResponded = true;
              const usage = readUsage(envelope);
              items.push(...mapExtractResults(
                urls,
                objectList(envelope.results) as Array<Record<string, unknown>>,
                objectList(envelope.failed_results) as Array<Record<string, unknown>>,
                {
                  requestId: providerContext.requestId,
                  runtimeId: providerContext.runtimeId,
                  fetchedAt: new Date().toISOString(),
                  serviceRequestId: requestId,
                  usageCredits: usage.credits,
                  // 索引在整个请求范围内下移，避免跨批次索引碰撞。
                  indexOffset: batchStart,
                },
                format,
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
          // （注意：不能用 items.length === 0 判定 —— 失败分支也会补逐项失败项，
          //   那样写会让这个分支永远不可达，注释意图与实际行为不符。）
          if (!anyBatchResponded && serviceFailure !== undefined) throw serviceFailure;

          return { items: items.sort((a, b) => a.index - b.index) };
        },

        async usage(providerContext: ProviderContext): Promise<ProviderUsageReport> {
          const { envelope } = await client.call<TavilyUsageEnvelope>(
            providerContext,
            "/usage",
            undefined,
            "usage",
            "GET",
          );

          const entries: ProviderUsageReport["entries"] = [];
          const key = asRecord(envelope.key);
          const account = asRecord(envelope.account);
          if (key && typeof key.usage === "number") {
            entries.push({
              scope: "credential",
              used: key.usage,
              limit: typeof key.limit === "number" ? key.limit : null,
              unit: "credits",
            });
          }
          if (account && typeof account.usage === "number") {
            entries.push({
              scope: "account",
              used: account.usage,
              limit: typeof account.plan_limit === "number" ? account.plan_limit : null,
              unit: "credits",
            });
          }

          return {
            service: "tavily",
            fetchedAt: Date.now(),
            accuracy: "official",
            supported: true,
            entries,
          };
        },
      };

      return provider;
    },
  };
}

/** 逐项失败只用本地安全文案与错误码，不携带上游原文。 */
function toSafeItemError(error: unknown): ExtractItem["error"] {
  if (error instanceof RetrievalError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "CONTENT_UNAVAILABLE", message: "Tavily could not extract this URL", retryable: false };
}

const tavilyFactory = createTavilyFactory();

export default {
  name: "aylens-tavily",
  version: "1.0.0",
  factories: [tavilyFactory],
};

export { tavilyFactory };
