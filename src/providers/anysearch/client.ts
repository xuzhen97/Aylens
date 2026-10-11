import { ApiCallExecutor } from "../../api-client/api-call-executor.js";
import type { ApiVendorPolicy } from "../../api-client/api-call-executor.js";
import type { HttpTransport } from "../../transports/types.js";
import type { ProviderContext, ProviderCredentialAccess } from "../types.js";
import {
  businessStatusOf,
  classifyAnySearchFailure,
  toAnySearchBusinessError,
  toAnySearchRetrievalError,
} from "./errors.js";
import type { AnySearchOperation } from "./errors.js";

const ANYSEARCH_ORIGIN = "https://api.anysearch.com";

export interface AnySearchEnvelope {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
  error_code?: unknown;
  data?: unknown;
}

interface AnySearchCallResult {
  envelope: AnySearchEnvelope;
  requestId?: string | undefined;
}

/**
 * 业务判定：**HTTP 200 也可能是失败**。
 *
 * 官方明确提醒「错误可以走 application code，不要假设每个错误都用 code: -1」，
 * 所以 2xx 之后必须校验 `code === 0`；缺失或形状不对一律 fail closed，
 * 不把无法判定的响应当成成功。
 */
function policyFor(operation: AnySearchOperation): ApiVendorPolicy<AnySearchCallResult> {
  return {
    classifyHttpError: ({ status, headers, body }) => ({
      ok: false,
      failure: classifyAnySearchFailure(operation, status, headers, body),
      error: toAnySearchRetrievalError(operation, status, headers),
    }),

    interpretSuccess: ({ headers, envelope }) => {
      const code = envelope.code;
      if (code === 0) {
        const envelopeRequestId = typeof envelope.request_id === "string" ? envelope.request_id : undefined;
        return {
          ok: true,
          value: {
            envelope,
            requestId: headers.get("x-request-id") ?? envelopeRequestId,
          },
        };
      }

      const numeric = typeof code === "number" ? code : Number.NaN;
      const mirroredStatus = businessStatusOf(numeric);
      return {
        ok: false,
        // 已知业务码按对应状态分类（可判定时才会碰凭据）；未知业务码只记 upstream/unknown，
        // 绝不因为一个陌生数字把 Key 隔离掉。
        failure: mirroredStatus === undefined
          ? { category: "upstream", scope: "unknown" }
          : classifyAnySearchFailure(operation, mirroredStatus, headers, ""),
        error: toAnySearchBusinessError(operation, numeric),
      };
    },
  };
}

/**
 * AnySearch HTTP 客户端。
 *
 * 凭据生命周期、认证头、超时与失败回报都由公共 `ApiCallExecutor` 承担；
 * 这里只保留 AnySearch 特有的东西：origin、Bearer 形状、端点、
 * 以及「按端点区分错误语义」——422 只在 Extract 出现，表示这一个 URL 提取不了。
 */
export class AnySearchClient {
  private readonly searchExecutor: ApiCallExecutor<AnySearchCallResult>;
  private readonly extractExecutor: ApiCallExecutor<AnySearchCallResult>;

  constructor(
    credentialAccess: ProviderCredentialAccess,
    transport: HttpTransport,
    options: { providerId: string },
  ) {
    const base = {
      providerId: options.providerId,
      origin: ANYSEARCH_ORIGIN,
      authHeader: (secret: string) => ({ Authorization: `Bearer ${secret}` }),
      credentials: credentialAccess,
      transport,
      serviceLabel: "AnySearch",
    };
    this.searchExecutor = new ApiCallExecutor(base, policyFor("search"));
    this.extractExecutor = new ApiCallExecutor(base, policyFor("extract"));
  }

  async search(context: ProviderContext, body: Record<string, unknown>): Promise<AnySearchCallResult> {
    return this.searchExecutor.call(context, {
      path: "/v1/search",
      method: "POST",
      body,
      endpointGroup: "search",
    });
  }

  /**
   * 单 URL 提取。
   *
   * body 只能是 `{ url }`：官方要求恰好一个对象、恰好一个非空字符串字段，
   * 多一个键或重复键都会被 400 拒绝，因此这里不提供任何透传通道。
   */
  async extractUrl(context: ProviderContext, url: string): Promise<AnySearchCallResult> {
    return this.extractExecutor.call(context, {
      path: "/v1/extract",
      method: "POST",
      body: { url },
      endpointGroup: "extract",
    });
  }
}

/** 只读取认识的字段：上游多加的键不会被原样带进 SearchDocument。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** `data` 段：形状不对时按空对象处理，由映射层决定逐项失败。 */
export function dataRecord(envelope: AnySearchEnvelope): Record<string, unknown> {
  return asRecord(envelope.data) ?? {};
}

/** 读取 Search 的元数据；缺省时不填（不猜 0）。 */
export function readSearchMetadata(envelope: AnySearchEnvelope): {
  searchTimeMs?: number | undefined;
  totalResults?: number | undefined;
} {
  const metadata = asRecord(dataRecord(envelope).metadata);
  const searchTimeMs = metadata?.search_time_ms;
  const totalResults = metadata?.total_results;
  return {
    ...(typeof searchTimeMs === "number" && Number.isFinite(searchTimeMs)
      ? { searchTimeMs }
      : {}),
    ...(typeof totalResults === "number" && Number.isFinite(totalResults) ? { totalResults } : {}),
  };
}
