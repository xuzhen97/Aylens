import type { Agent as HttpAgent } from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { TransportConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import { nodeRequest } from "./node-request.js";
import type { HttpTransport, TransportFactory, TransportRequest, TransportResponse } from "./types.js";

export class Socks5Transport implements HttpTransport {
  private readonly agent: HttpAgent;

  constructor(
    public readonly id: string,
    proxyUrl: string,
  ) {
    this.agent = new SocksProxyAgent(proxyUrl);
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    try {
      return await nodeRequest(request, this.agent);
    } catch (error) {
      throw new RetrievalError("PROXY_FAILED", `SOCKS5 proxy request failed: ${this.id}`, {
        retryable: true,
        cause: error,
      });
    }
  }
}

export class Socks5TransportFactory implements TransportFactory {
  readonly type = "socks5" as const;

  create(id: string, config: TransportConfig): HttpTransport {
    if (config.type !== this.type) throw new Error(`Invalid config for transport factory: ${this.type}`);
    return new Socks5Transport(id, config.url);
  }
}
