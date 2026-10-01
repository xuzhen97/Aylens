import type { AppConfig } from "../config/schema.js";
import { ProviderRegistry } from "../providers/registry.js";
import { RuntimeRegistry } from "../runtime/registry.js";
import { RunnerSessionManager } from "../runtime/runner-session-manager.js";
import { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { InMemoryAuditService } from "../audit/audit-service.js";
import { ProviderRouter } from "../search/router.js";
import { SearchService } from "../search/search-service.js";

/**
 * Gateway 上下文：仅负责控制面。
 *
 * 这里保存 Provider 逻辑定义与调度要求、Runner 注册表、Runner 会话和审计信息。
 * 它刻意不持有 Transport、BrowserHost 或 Browser Profile；这些执行资源只属于 Runner。
 * 详细边界见 docs/architecture.md。
 */
export interface GatewayContext {
  config: AppConfig;
  providers: ProviderRegistry;
  runtimes: RuntimeRegistry;
  runnerSessions: RunnerSessionManager;
  dispatcher: ExecutionDispatcher;
  audit: InMemoryAuditService;
  search: SearchService;
}

export function createGatewayContext(config: AppConfig): GatewayContext {
  const providers = new ProviderRegistry();
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    providers.addDefinition(id, providerConfig);
  }

  const runtimes = new RuntimeRegistry(config.runtimeRegistry.offlineAfterMs);
  const runnerSessions = new RunnerSessionManager(config.runtimeRegistry.jobTimeoutMs);
  const dispatcher = new ExecutionDispatcher(providers, runtimes, runnerSessions);
  const audit = new InMemoryAuditService();
  const router = new ProviderRouter(config);
  const search = new SearchService(router, dispatcher, audit);

  return { config, providers, runtimes, runnerSessions, dispatcher, audit, search };
}
