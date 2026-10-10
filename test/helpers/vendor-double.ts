import { RetrievalError } from "../../src/core/errors.js";
import { ApiCallExecutor } from "../../src/api-client/api-call-executor.js";
import type { ApiVendorPolicy } from "../../src/api-client/api-call-executor.js";
import type { ExtractItem, ExtractRequest, ProviderExtractResponse } from "../../src/contracts/extract.js";
import type { SearchDocument, SearchRequest } from "../../src/contracts/search.js";
import type {
  ProviderCapability,
  ProviderContext,
  ProviderCredentialAccess,
  ProviderFactoryContext,
} from "../../src/providers/types.js";
import type { CredentialFailure } from "../../src/runner/credentials/types.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../../src/transports/types.js";

/**
 * 测试专用服务商替身：证明公共层能承接不同服务商的**形状差异**，
 * 而不是把 Tavily 的形状当成所有服务商的前提。
 *
 * 刻意不是可上线实现（Spec §10）：它只实现足以证明契约的那部分。
 *
 * 可配置的形状：
 * - `nativeBatchSize`：原生批次上限（Exa 100 / Tavily 20 / AnySearch 1）；
 * - `bodyCodeMode`：是否用响应体业务码判成败（AnySearch 形状），
 *   此时 HTTP 200 也可能是失败；
 * - `maxConcurrentExtracts`：单 URL 适配器必须自己做的有界并发。
 */
export interface VendorDoubleOptions {
  service: string;
  nativeBatchSize: number;
  bodyCodeMode?: boolean;
  maxConcurrentExtracts?: number;
}

interface VendorEnvelope {
  request_id?: unknown;
  code?: unknown;
  message?: unknown;
  results?: unknown;
  failed_results?: unknown;
}

export interface VendorDoubleCall {
  path: string;
  urls: string[];
}

/** 记录调用并支持观测并发峰值的假 Transport。 */
export class ConcurrencyTrackingTransport implements HttpTransport {
  readonly id = "direct";
  readonly calls: VendorDoubleCall[] = [];
  maxObservedConcurrency = 0;

  private inFlight = 0;

  constructor(
    private readonly respond: (request: { path: string; urls: string[] }) => {
      status: number;
      body: string;
    },
  ) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    const path = new URL(request.url).pathname;
    const parsedBody = request.body ? JSON.parse(request.body) as { urls?: string[] } : {};
    const urls = parsedBody.urls ?? [];
    this.calls.push({ path, urls });

    this.inFlight += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.inFlight);
    try {
      // 让出事件循环，使并发调用真的重叠，否则测不出并发上限。
      await new Promise((resolve) => setTimeout(resolve, 1));
      const result = this.respond({ path, urls });
      return { status: result.status, headers: new Headers(), body: result.body };
    } finally {
      this.inFlight -= 1;
    }
  }
}

export interface VendorDoubleProvider {
  capabilities: readonly ProviderCapability[];
  search(context: ProviderContext, request: SearchRequest): Promise<{ items: SearchDocument[] }>;
  extract(context: ProviderContext, request: ExtractRequest): Promise<ProviderExtractResponse>;
}

function buildPolicy(
  options: VendorDoubleOptions,
  credentialAccess: ProviderCredentialAccess,
): { factoryCreate: (id: string, context: ProviderFactoryContext) => VendorDoubleProvider } {
  const policy: ApiVendorPolicy<{ envelope: VendorEnvelope }> = {
    classifyHttpError: ({ status }) => {
      const failure: CredentialFailure | undefined = status === 401
        ? { category: "auth", scope: "credential" }
        : status === 429
          ? { category: "rate_limited", scope: "credential" }
          : undefined;
      return {
        ok: false,
        failure,
        error: new RetrievalError("UPSTREAM_ERROR", `${options.service} request failed`, { retryable: status >= 500 }),
      };
    },
    interpretSuccess: ({ envelope }) => {
      // AnySearch 形状：HTTP 200 仍要看业务码。
      if (options.bodyCodeMode && envelope.code !== 0) {
        return {
          ok: false,
          failure: { category: "quota", scope: "account" },
          error: new RetrievalError("PROVIDER_UNAVAILABLE", `${options.service} rejected the request`, { retryable: false }),
        };
      }
      return { ok: true, value: { envelope } };
    },
  };

  return {
    factoryCreate: (id, context) => {
      const executor = new ApiCallExecutor(
        {
          providerId: id,
          origin: "https://vendor.test",
          authHeader: (secret) => ({ Authorization: `Bearer ${secret}` }),
          credentials: context.credentials ?? credentialAccess,
          transport: context.transports.get("direct"),
          serviceLabel: options.service,
        },
        policy,
      );

      /**
       * 按原生批次上限拆分；上限为 1 时即单 URL 适配器，
       * 必须自己用有界并发，避免把上游打爆。
       */
      const runBatches = async (context: ProviderContext, urls: string[]): Promise<Array<{ url: string; ok: boolean; body?: string }>> => {
        const batches: string[][] = [];
        for (let index = 0; index < urls.length; index += options.nativeBatchSize) {
          batches.push(urls.slice(index, index + options.nativeBatchSize));
        }

        const limit = options.maxConcurrentExtracts ?? batches.length;
        const results: Array<{ url: string; ok: boolean; body?: string }> = [];
        let cursor = 0;

        const worker = async () => {
          while (cursor < batches.length) {
            const batch = batches[cursor] as string[];
            cursor += 1;
            try {
              const { envelope } = await executor.call(context, {
                path: "/extract",
                method: "POST",
                body: { urls: batch },
                endpointGroup: "extract",
              });
              const payload = envelope as { results?: Array<{ url: string; raw_content: string }> };
              for (const url of batch) {
                const hit = payload.results?.find((entry) => entry.url === url);
                results.push(hit ? { url, ok: true, body: hit.raw_content } : { url, ok: false });
              }
            } catch {
              for (const url of batch) results.push({ url, ok: false });
            }
          }
        };

        await Promise.all(Array.from({ length: Math.min(limit, batches.length) }, () => worker()));
        return results;
      };

      return {
        capabilities: ["search", "extract"] as const,
        search: async () => ({ items: [] as SearchDocument[] }),
        extract: async (context, request) => {
          const results = await runBatches(context, request.urls);
          const items: ExtractItem[] = results.map((result) => {
            const index = request.urls.indexOf(result.url);
            if (!result.ok) {
              return {
                index,
                url: result.url,
                status: "failed",
                error: { code: "CONTENT_UNAVAILABLE", message: `${options.service} could not extract this URL`, retryable: false },
              };
            }
            return {
              index,
              url: result.url,
              status: "success",
              document: {
                id: `${options.service}_${index}`,
                platform: "web",
                type: "webpage",
                url: result.url,
                text: result.body ?? "",
                retrievedAt: new Date().toISOString(),
                provenance: {
                  provider: id,
                  retrievalMethod: "api_extract",
                  requestId: context.requestId,
                  fetchedAt: new Date().toISOString(),
                  runtimeId: context.runtimeId,
                },
              },
            };
          });
          return { items };
        },
      };
    },
  };
}

/**
 * 造一个服务商替身 Provider。
 * 返回 provider 实例，供测试直接经 ExtractService / 凭据池观察行为。
 */
export function createVendorDouble(
  service: string,
  options: Omit<VendorDoubleOptions, "service"> &
    { credentials: ProviderCredentialAccess; transports: ProviderFactoryContext["transports"] },
): VendorDoubleProvider {
  const built = buildPolicy({ service, ...options }, options.credentials);
  return built.factoryCreate(service, { transports: options.transports, credentials: options.credentials });
}
