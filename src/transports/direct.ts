import type { TransportConfig } from "../config/schema.js";
import type { HttpTransport, TransportFactory, TransportRequest, TransportResponse } from "./types.js";

export class DirectTransport implements HttpTransport {
  constructor(public readonly id: string) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
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
