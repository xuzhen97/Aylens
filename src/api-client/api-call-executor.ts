import { RetrievalError } from "../core/errors.js";
import { ApiJsonClient } from "./json-client.js";
import type { HttpTransport } from "../transports/types.js";
import type { ProviderContext, ProviderCredentialAccess } from "../providers/types.js";
import type { CredentialFailure } from "../runner/credentials/types.js";

/**
 * 服务商对一次 HTTP 交换的判定结果。
 *
 * 分成「HTTP 层失败」与「2xx 后的业务判定」两步，是为了容纳两类服务商：
 * - Tavily：成败只看 HTTP 状态；
 * - AnySearch：HTTP 200 仍可能带 `code != 0` 的业务失败。
 * 公共层不假设是哪种，只负责把结果转成凭据回报 + 对外错误。
 */
export type ApiCallVerdict<T> =
  | { ok: true; value: T }
  | { ok: false; failure?: CredentialFailure | undefined; error: RetrievalError };

export interface ApiVendorPolicy<T> {
  /** 非 2xx：由服务商适配器给出失败分类与对外错误（固定安全文案）。 */
  classifyHttpError(result: {
    status: number;
    headers: Headers;
    body: string;
  }): ApiCallVerdict<T>;
  /**
   * 2xx 且 body 已是 JSON 对象后调用。
   * 服务商可在此按业务码判失败（AnySearch 形状），也可直接放行（Tavily 形状）。
   */
  interpretSuccess(result: {
    status: number;
    headers: Headers;
    envelope: Record<string, unknown>;
  }): ApiCallVerdict<T>;
}

export interface ApiCallPlan {
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown> | undefined;
  /** 限流分组：同一服务商不同接口可独立冷却。 */
  endpointGroup: string;
}

export interface ApiCallExecutorOptions {
  providerId: string;
  /** 受信 origin；认证头不会发往别处。 */
  origin: string;
  /** 由服务商决定认证头形状（Bearer / x-api-key …）。 */
  authHeader: (secret: string) => Record<string, string>;
  credentials: ProviderCredentialAccess;
  transport: HttpTransport;
  /** 安全错误文案里出现的服务名，用于区分「哪个上游失败了」。 */
  serviceLabel: string;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 公共 API 执行机制。
 *
 * 负责每个服务商都要做、且做错就会静默出错的那部分：
 * - 每次调用占用一把凭据并在 `finally` 释放（取消/超时/4xx 都不泄漏并发额度）；
 * - 认证头只发往受信 origin，不跟随重定向（由 ApiJsonClient 保证）；
 * - 统一把失败同时回报给凭据池与调用方，避免「池认为可用但接口报错」；
 * - 网络/超时错误不诬陷凭据（不标成 Key 坏了）。
 *
 * 服务商差异（端点、参数、批次、错误语义）全部留在各自的 policy 与适配器里。
 */
export class ApiCallExecutor<T> {
  private readonly http: ApiJsonClient;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: ApiCallExecutorOptions,
    private readonly policy: ApiVendorPolicy<T>,
  ) {
    this.http = new ApiJsonClient(options.transport, { allowedOrigin: options.origin });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async call(context: ProviderContext, plan: ApiCallPlan): Promise<T> {
    const { poolId, pool } = this.options.credentials.poolForProvider(this.options.providerId);
    const lease = pool.acquire(poolId, {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      endpointGroup: plan.endpointGroup,
    });

    try {
      const response = await this.http.send({
        url: `${this.options.origin}${plan.path}`,
        method: plan.method,
        headers: {
          ...this.options.authHeader(lease.secret),
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        timeoutMs: this.timeoutMs,
      });

      const verdict = response.status >= 200 && response.status < 300
        ? this.policy.interpretSuccess({
          status: response.status,
          headers: response.headers,
          envelope: this.parseEnvelope(response.body),
        })
        : this.policy.classifyHttpError({
          status: response.status,
          headers: response.headers,
          body: response.body,
        });

      if (verdict.ok) {
        lease.reportSuccess();
        return verdict.value;
      }

      if (verdict.failure) lease.reportFailure(verdict.failure);
      throw verdict.error;
    } catch (error) {
      // 已分类的 RetrievalError 直接上抛；其余按网络/超时处理，
      // 且不把凭据标坏——网络故障不证明 Key 失效。
      if (error instanceof RetrievalError) throw error;
      lease.reportFailure({ category: "network", scope: "unknown" });
      throw new RetrievalError(
        context.signal?.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        `${this.options.serviceLabel} request could not be completed`,
        { retryable: true, cause: error },
      );
    } finally {
      lease.release();
    }
  }

  /** 2xx 的 body 必须是 JSON 对象；解析失败不回显原文。 */
  private parseEnvelope(body: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new RetrievalError(
        "PARSE_ERROR",
        `${this.options.serviceLabel} returned a malformed response`,
        { retryable: false },
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RetrievalError(
        "PARSE_ERROR",
        `${this.options.serviceLabel} returned a malformed response`,
        { retryable: false },
      );
    }
    return parsed as Record<string, unknown>;
  }
}
