import type { Agent as HttpAgent } from "node:http";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { TransportConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import { nodeRequest } from "./node-request.js";
import type { HttpTransport, TransportFactory, TransportRequest, TransportResponse } from "./types.js";

export class HttpProxyTransport implements HttpTransport {
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpAgent;

  constructor(
    public readonly id: string,
    proxyUrl: string,
  ) {
    this.httpAgent = new HttpProxyAgent(proxyUrl);
    this.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const target = new URL(request.url);

    try {
      return await nodeRequest(
        request,
        target.protocol === "https:" ? this.httpsAgent : this.httpAgent,
      );
    } catch (error) {
      throw new RetrievalError("PROXY_FAILED", `HTTP proxy request failed: ${this.id}`, {
        retryable: true,
        cause: error,
      });
    }
  }
}

export class HttpProxyTransportFactory implements TransportFactory {
  readonly type = "http-proxy" as const;

  create(id: string, config: TransportConfig): HttpTransport {
    if (config.type !== this.type) throw new Error(`Invalid config for transport factory: ${this.type}`);
    return new HttpProxyTransport(id, config.url);
  }
}
