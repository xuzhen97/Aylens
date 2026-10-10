import { ApiCallExecutor } from "../../api-client/api-call-executor.js";
import type { ApiVendorPolicy } from "../../api-client/api-call-executor.js";
import type { HttpTransport } from "../../transports/types.js";
import type { ProviderContext, ProviderCredentialAccess } from "../types.js";
import { classifyTavilyFailure, toTavilyRetrievalError } from "./errors.js";

const TAVILY_ORIGIN = "https://api.tavily.com";

export interface TavilyCallOptions {
  providerId: string;
  deploymentOptions: Record<string, unknown>;
}

interface TavilyEnvelope {
  request_id?: unknown;
  response_time?: unknown;
  usage?: { credits?: unknown };
}

/** Tavily 的成败只看 HTTP 状态；2xx 后 body 一定放行。 */
const tavilyPolicy: ApiVendorPolicy<{ envelope: TavilyEnvelope; requestId?: string | undefined }> = {
  classifyHttpError: ({ status, headers, body }) => ({
    ok: false,
    failure: classifyTavilyFailure(status, headers, body),
    error: toTavilyRetrievalError(status, headers),
  }),
  interpretSuccess: ({ headers, envelope }) => {
    const envelopeRequestId = typeof envelope.request_id === "string" ? envelope.request_id : undefined;
    return {
      ok: true,
      value: {
        envelope: envelope as TavilyEnvelope,
        requestId: headers.get("x-request-id") ?? envelopeRequestId,
      },
    };
  },
};

/**
 * Tavily HTTP 客户端。
 *
 * 凭据生命周期、认证头、超时与失败回报都由公共 `ApiCallExecutor` 承担；
 * 这里只保留 Tavily 特有的端点与语义（错误分类、响应 envelope）。
 */
export class TavilyClient {
  private readonly executor: ApiCallExecutor<{ envelope: TavilyEnvelope; requestId?: string | undefined }>;

  constructor(
    credentialAccess: ProviderCredentialAccess,
    transport: HttpTransport,
    options: TavilyCallOptions,
  ) {
    this.executor = new ApiCallExecutor(
      {
        providerId: options.providerId,
        origin: TAVILY_ORIGIN,
        authHeader: (secret) => ({ Authorization: `Bearer ${secret}` }),
        credentials: credentialAccess,
        transport,
        serviceLabel: "Tavily",
      },
      tavilyPolicy,
    );
  }

  /**
   * 发一次 Tavily 调用并把响应 envelope 解包。
   * `endpointGroup` 让 search / extract / usage 的限流可以分开计算。
   */
  async call<T extends TavilyEnvelope>(
    context: ProviderContext,
    endpoint: "/search" | "/extract" | "/usage",
    body: Record<string, unknown> | undefined,
    endpointGroup: string,
    method: "GET" | "POST" = "POST",
  ): Promise<{ envelope: T; requestId?: string | undefined }> {
    const result = await this.executor.call(context, {
      path: endpoint,
      method,
      ...(body !== undefined ? { body } : {}),
      endpointGroup,
    });
    return { envelope: result.envelope as T, requestId: result.requestId };
  }
}

/** 从响应 envelope 读取已知的用量与耗时字段，缺省时不填（不猜 0）。 */
export function readUsage(envelope: TavilyEnvelope): { credits?: number | undefined; responseTimeMs?: number | undefined } {
  const credits = typeof envelope.usage?.credits === "number" ? envelope.usage.credits : undefined;
  const responseTime = typeof envelope.response_time === "number" ? envelope.response_time : undefined;
  return {
    ...(credits !== undefined ? { credits } : {}),
    ...(responseTime !== undefined ? { responseTimeMs: Math.round(responseTime * 1_000) } : {}),
  };
}

export type { TavilyEnvelope };
