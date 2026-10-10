/** 一次受控的上游 API 调用请求。 */
export interface ApiCallRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
  /** 本次调用的总时限；由调用方的检索预算传入，不由客户端自行放大。 */
  timeoutMs: number;
}

export interface ApiCallResult {
  status: number;
  headers: Headers;
  body: string;
  /** 上游返回的请求 ID（若有），仅用于排障，不替代 Aylens requestId/traceId。 */
  requestId?: string | undefined;
}

export interface ApiJsonClientOptions {
  /**
   * 唯一允许携带认证头的目标 origin。
   * 只有受信 origin 才会收到 Authorization，避免重定向或错误配置把 Key 发给第三方。
   */
  allowedOrigin: string;
  /** 响应体上限（解码后字节数/字符数）。超限明确失败，绝不静默截断后当作完整正文。 */
  maxBytes?: number | undefined;
}
