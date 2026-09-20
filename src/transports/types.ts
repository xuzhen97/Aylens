import type { TransportConfig } from "../config/schema.js";

export interface TransportRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  body: string;
}

export interface HttpTransport {
  readonly id: string;
  request(request: TransportRequest): Promise<TransportResponse>;
}

export interface TransportFactory {
  readonly type: TransportConfig["type"];
  create(id: string, config: TransportConfig): HttpTransport;
}
