import { ApiCallExecutor } from "../../api-client/api-call-executor.js";
import type { ApiVendorPolicy } from "../../api-client/api-call-executor.js";
import type { HttpTransport } from "../../transports/types.js";
import type { ProviderContext, ProviderCredentialAccess } from "../types.js";
import { classifyExaFailure, toExaRetrievalError } from "./errors.js";

const EXA_ORIGIN = "https://api.exa.ai";

export interface ExaCallOptions {
  providerId: string;
}

interface ExaEnvelope {
  requestId?: unknown;
}

/** Exa 的成败只看 HTTP 状态；2xx 后 body 一定放行。 */
const exaPolicy: ApiVendorPolicy<{ envelope: ExaEnvelope; requestId?: string | undefined }> = {
  classifyHttpError: ({ status, headers, body }) => ({
    ok: false,
    failure: classifyExaFailure(status, headers, body),
    error: toExaRetrievalError(status, headers),
  }),
  interpretSuccess: ({ envelope }) => {
    const envelopeRequestId = typeof envelope.requestId === "string" ? envelope.requestId : undefined;
    return {
      ok: true,
      value: {
        envelope: envelope as ExaEnvelope,
        ...(envelopeRequestId !== undefined ? { requestId: envelopeRequestId } : {}),
      },
    };
  },
};

/**
 * Exa HTTP 客户端。
 *
 * 凭据生命周期、认证头、超时与失败回报都由公共 `ApiCallExecutor` 承担；
 * 这里只保留 Exa 特有的东西：origin、`x-api-key` 认证形状、端点与响应 envelope。
 */
export class ExaClient {
  private readonly executor: ApiCallExecutor<{ envelope: ExaEnvelope; requestId?: string | undefined }>;

  constructor(
    credentialAccess: ProviderCredentialAccess,
    transport: HttpTransport,
    options: ExaCallOptions,
  ) {
    this.executor = new ApiCallExecutor(
      {
        providerId: options.providerId,
        origin: EXA_ORIGIN,
        // Exa 官方也接受 Authorization: Bearer，但文档示例与 SDK 都用 x-api-key。
        authHeader: (secret) => ({ "x-api-key": secret }),
        credentials: credentialAccess,
        transport,
        serviceLabel: "Exa",
      },
      exaPolicy,
    );
  }

  /**
   * 发一次 Exa 调用并解包 envelope。
   * `endpointGroup` 让 search / contents 的限流分开计算。
   */
  async call<T extends ExaEnvelope>(
    context: ProviderContext,
    endpoint: "/search" | "/contents",
    body: Record<string, unknown>,
    endpointGroup: string,
  ): Promise<{ envelope: T; requestId?: string | undefined }> {
    const result = await this.executor.call(context, {
      path: endpoint,
      method: "POST",
      body,
      endpointGroup,
    });
    return { envelope: result.envelope as T, ...(result.requestId !== undefined ? { requestId: result.requestId } : {}) };
  }
}

/** 从响应 envelope 读取官方费用字段；缺省时不填（不猜 0）。 */
export function readCostUsd(envelope: { costDollars?: unknown }): number | undefined {
  const cost = envelope.costDollars;
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return undefined;
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

export type { ExaEnvelope };
