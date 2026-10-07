import type { TransportConfig } from "../config/schema.js";

/**
 * 受限获取策略。只在需要“下载阶段就限流并禁止自动重定向”的调用方（url-fetch）设置；
 * 未携带该策略的旧请求保持原有 Transport 行为不变。
 */
export interface TransportResponsePolicy {
  /** 压缩前的原始响应字节上限。 */
  maxBytes: number;
  /** 解压后的字节上限，用于抵御解压炸弹。 */
  maxDecodedBytes: number;
  /** 网页文本解码规则（BOM → HTTP charset → HTML meta → UTF-8）。 */
  decode: "web";
  /** 必须由调用层逐跳校验重定向，传输层不得自动跟随。 */
  redirect: "manual";
  /** public 需要逐跳目标校验；controlled-egress 表示出口已由部署环境约束。 */
  network: "public" | "controlled-egress";
}

export interface TransportRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal | undefined;
  responsePolicy?: TransportResponsePolicy | undefined;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  body: string;
  /** 受限获取时返回解码后的字节，供 HTML 提取按原始字节解析。 */
  bodyBytes?: Uint8Array | undefined;
  /** 受限获取时返回实际使用的最终 URL（重定向由调用层维护）。 */
  finalUrl?: string | undefined;
  /** 声明编码与实际字节不符而进行了降级解码时记录原因，绝不静默处理。 */
  decodeWarning?: string | undefined;
}

export interface HttpTransport {
  readonly id: string;
  request(request: TransportRequest): Promise<TransportResponse>;
}

export interface TransportFactory {
  readonly type: TransportConfig["type"];
  create(id: string, config: TransportConfig): HttpTransport;
}
