import type { TransportConfig } from "../config/schema.js";
import { nodeRequest } from "./node-request.js";
import type { HttpTransport, TransportFactory, TransportRequest, TransportResponse } from "./types.js";

export class DirectTransport implements HttpTransport {
  constructor(public readonly id: string) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    // 受限获取必须手动处理重定向，并在读取阶段就限流、解压与解码；
    // fetch 的自动重定向会绕过调用层的逐跳安全校验，因此这里改走 Node 请求路径。
    if (request.responsePolicy) return nodeRequest(request);

    const init: RequestInit = { method: request.method ?? "GET" };
    if (request.headers) init.headers = request.headers;
    if (request.body !== undefined) init.body = request.body;
    if (request.signal) init.signal = request.signal;

    const response = await fetch(request.url, init);
    return { status: response.status, headers: response.headers, body: await response.text() };
  }
}

export class DirectTransportFactory implements TransportFactory {
  readonly type = "direct" as const;

  create(id: string, config: TransportConfig): HttpTransport {
    if (config.type !== this.type) throw new Error(`Invalid config for transport factory: ${this.type}`);
    return new DirectTransport(id);
  }
}
