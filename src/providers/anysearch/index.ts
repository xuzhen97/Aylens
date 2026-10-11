import type { ExtractItem, ExtractRequest, ProviderExtractResponse } from "../../contracts/extract.js";
import type { ProviderSearchResponse, SearchDocument, SearchRequest } from "../../contracts/search.js";
import { RetrievalError } from "../../core/errors.js";
import type {
  ProviderContext,
  ProviderFactory,
  ProviderFactoryContext,
} from "../types.js";
import { AnySearchClient, dataRecord, readSearchMetadata } from "./client.js";
import { CONTENT_UNAVAILABLE_MESSAGE } from "./errors.js";
import { mapExtractDocument, mapSearchResults } from "./mapping.js";
import {
  resolveExtractParams,
  resolveMaxConcurrentExtracts,
  resolveSearchParams,
  splitDeploymentOptions,
} from "./params.js";

/** 上游 `/v1/search` 的 `max_results` 上限（官方文档：1–10，默认 10）。 */
const NATIVE_SEARCH_LIMIT = 10;

const DEFAULT_TRANSPORT_ID = "direct";

/** 仅接受记录形状的对象：上游把 results 写成别的类型时按空结果处理而不是崩掉。 */
function objectList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

export function createAnySearchFactory(): ProviderFactory {
  return {
    type: "anysearch",
    // 与 Exa 同理：文档没有 Key 用量端点（额度在控制台按天计量），不声明 usage。
    capabilities: ["search", "extract"],

    create(id, config, context: ProviderFactoryContext) {
      // 没有凭据池就不能发请求。
      // ⚠️ 绝不退回匿名：官方 401 语义本身就是「无效凭据不回退匿名」，
      // 而且匿名额度耗尽的 402 响应里会带自动注册生成的账号密码与 API Key
      // （官方要求整包按敏感数据处理）—— 我们不想要那种东西出现在自己的链路里。
      if (!context.credentials) {
        throw new RetrievalError(
          "PROVIDER_UNAVAILABLE",
          `AnySearch provider requires a runner credential pool: ${id}`,
          { retryable: false },
        );
      }

      const transportId = config.transport?.primary ?? DEFAULT_TRANSPORT_ID;
      const transport = context.transports.get(transportId);
      // 适配器自用选项（并发上限）不参与上游白名单校验，也绝不进请求体。
      const { adapter, upstream } = splitDeploymentOptions(config.options ?? {});
      const maxConcurrentExtracts = resolveMaxConcurrentExtracts(adapter);
      const client = new AnySearchClient(context.credentials, transport, { providerId: id });

      return {
        id,

        async search(providerContext: ProviderContext, request: SearchRequest): Promise<ProviderSearchResponse> {
          const params = resolveSearchParams(upstream, request.providerOptions);

          // 通用字段是**提示**（最弱优先级）：部署层默认值与请求级专属选项都能覆盖它。
          const derived: Record<string, unknown> = {};
          if (request.language !== undefined) derived.language = request.language;
          if (request.content?.format === "markdown") derived.format = "markdown";
          const merged: Record<string, unknown> = { ...derived, ...params };

          // 上游最多 10 条，契约允许到 100。**不静默截断**：
          // 发上游能接受的值，同时在 extensions 里标出「想要多少、实际用了多少」。
          const requestedLimit = request.limit;
          const appliedLimit = requestedLimit === undefined
            ? undefined
            : Math.min(requestedLimit, NATIVE_SEARCH_LIMIT);
          const limitCapped = requestedLimit !== undefined && requestedLimit > NATIVE_SEARCH_LIMIT
            ? { requested: requestedLimit, applied: NATIVE_SEARCH_LIMIT }
            : undefined;

          const body: Record<string, unknown> = {
            query: request.query,
            ...(appliedLimit !== undefined ? { max_results: appliedLimit } : {}),
            ...merged,
          };

          const { envelope, requestId } = await client.search(providerContext, body);
          const metadata = readSearchMetadata(envelope);
          const fetchedAt = new Date().toISOString();
          const data = dataRecord(envelope);
          const markdownRequested = merged.format === "markdown";

          const items: SearchDocument[] = mapSearchResults(
            objectList(data.results),
            {
              requestId: providerContext.requestId,
              runtimeId: providerContext.runtimeId,
              fetchedAt,
              ...(requestId !== undefined ? { serviceRequestId: requestId } : {}),
              ...(metadata.searchTimeMs !== undefined ? { searchTimeMs: metadata.searchTimeMs } : {}),
              requestedFullContent: request.content?.mode === "full",
              requestedSummary: request.content?.mode === "summary",
              markdownRequested,
              ...(limitCapped !== undefined ? { limitCapped } : {}),
            },
            { provider: id, requestId: providerContext.requestId },
          );

          return { items: items.slice(0, requestedLimit ?? items.length) };
        },

        /**
         * Extract：上游一次只接受一个 URL，必须在适配器里做**有界并发**。
         *
         * 100 个 URL = 100 次调用；不设上限会自己把自己打成上游限流
         * （免费档量级 20 QPS/Key），所以默认并发保守，并允许部署层覆盖。
         * 逐 URL 汇总，索引用全局下标（不做批内相对计数）。
         */
        async extract(providerContext: ProviderContext, request: ExtractRequest): Promise<ProviderExtractResponse> {
          // Extract 没有任何可放行的选项：body 只能是 { url }，传什么都明确报错。
          resolveExtractParams(upstream, request.providerOptions);

          const results = new Map<number, ExtractItem>();
          let cursor = 0;
          let firstServiceFailure: unknown;
          let anySuccess = false;

          const worker = async (): Promise<void> => {
            for (;;) {
              const index = cursor;
              cursor += 1;
              if (index >= request.urls.length) return;
              const url = request.urls[index] as string;

              try {
                const { envelope, requestId } = await client.extractUrl(providerContext, url);
                const document = mapExtractDocument(url, dataRecord(envelope), {
                  requestId: providerContext.requestId,
                  runtimeId: providerContext.runtimeId,
                  fetchedAt: new Date().toISOString(),
                  ...(requestId !== undefined ? { serviceRequestId: requestId } : {}),
                });

                if (document === undefined) {
                  // HTTP 200 但没有可用正文：判逐项失败，不拿空文档冒充成功。
                  results.set(index, {
                    index,
                    url,
                    status: "failed",
                    error: { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false },
                  });
                  continue;
                }

                anySuccess = true;
                results.set(index, { index, url, status: "success", document });
              } catch (error) {
                // 单个 URL 失败不牵连其他 URL：422 这类逐项失败尤其不能变成整体失败。
                if (firstServiceFailure === undefined) firstServiceFailure = error;
                results.set(index, { index, url, status: "failed", error: toSafeItemError(error) });
              }
            }
          };

          const workers = Math.max(1, Math.min(maxConcurrentExtracts, request.urls.length));
          await Promise.all(Array.from({ length: workers }, () => worker()));

          // 一个 URL 都没成功、且确实存在服务级错误时才上抛，
          // 让 meta 与审计拿到真实错误码；有成功项就返回逐项结果，由 ExtractService 判 partial。
          if (!anySuccess && firstServiceFailure !== undefined) throw firstServiceFailure;

          return { items: [...results.values()].sort((left, right) => left.index - right.index) };
        },
      };
    },
  };
}

/** 逐项失败只用本地安全文案与错误码，不携带上游 message 原文。 */
function toSafeItemError(error: unknown): ExtractItem["error"] {
  if (error instanceof RetrievalError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "CONTENT_UNAVAILABLE", message: CONTENT_UNAVAILABLE_MESSAGE, retryable: false };
}

const anySearchFactory = createAnySearchFactory();

export default {
  name: "aylens-anysearch",
  version: "1.0.0",
  factories: [anySearchFactory],
};

export { anySearchFactory };
