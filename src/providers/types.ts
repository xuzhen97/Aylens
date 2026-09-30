import type { ProviderConfig, ProviderDeploymentConfig } from "../config/schema.js";
import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";
import type { BrowserHost } from "../browser/types.js";
import type { TransportRegistry } from "../transports/registry.js";

export interface ProviderContext {
  requestId: string;
  traceId: string;
  runtimeId: string;
  jobId?: string | undefined;
  /**
   * 当 Gateway 放弃任务或 Runner 正在关闭时触发取消；能响应取消信号的 Provider 应尽快停止工作。
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
  /** Runner 级默认浏览器 Profile；Provider 未显式指定时可复用同一持久化工作区。 */
  defaultBrowserProfile?: string | undefined;
}

export interface ProviderFactory {
  readonly type: string;
  create(
    id: string,
    config: ProviderDeploymentConfig,
    context: ProviderFactoryContext,
  ): SearchProvider;
}

export interface ProviderDefinition {
  id: string;
  config: ProviderConfig;
}
