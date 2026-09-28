import type { ProviderConfig } from "../config/schema.js";
import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";
import type { BrowserHost } from "../browser/types.js";
import type { TransportRegistry } from "../transports/registry.js";

export interface ProviderContext {
  requestId: string;
  traceId: string;
  runtimeId: string;
  jobId?: string | undefined;
  /**
   * Aborted when the execution is cancelled — the Gateway gave up on the job,
   * or the Runner is shutting down. Providers that can honour it should; the
   * option is additive so existing plugins keep working unchanged.
   */
  signal?: AbortSignal | undefined;
}

export interface SearchProvider {
  readonly id: string;
  search(context: ProviderContext, request: SearchRequest): Promise<ProviderSearchResponse>;
}

export interface ProviderFactoryContext {
  transports: TransportRegistry;
  browser?: BrowserHost | undefined;
}

export interface ProviderFactory {
  readonly type: string;
  create(
    id: string,
    config: ProviderConfig,
    context: ProviderFactoryContext,
  ): SearchProvider;
}

export interface ProviderDefinition {
  id: string;
  config: ProviderConfig;
}
