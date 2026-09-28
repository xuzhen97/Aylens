import type { AppConfig } from "../config/schema.js";
import { ProviderRegistry } from "../providers/registry.js";
import { RuntimeRegistry } from "../runtime/registry.js";
import { RunnerSessionManager } from "../runtime/runner-session-manager.js";
import { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { InMemoryAuditService } from "../audit/audit-service.js";
import { ProviderRouter } from "../search/router.js";
import { SearchService } from "../search/search-service.js";

/**
 * Gateway context: control plane only.
 *
 * It holds provider definitions and scheduling requirements, the Runner
 * registry, Runner sessions, and audit. It deliberately holds no transports,
 * browser host, or browser profiles — those belong to Runner (see
 * docs/adr/2026-09-28-gateway-control-plane-only.md).
 */
export interface GatewayContext {
  config: AppConfig;
  providers: ProviderRegistry;
  runtimes: RuntimeRegistry;
  runnerSessions: RunnerSessionManager;
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

  return { config, providers, runtimes, runnerSessions, audit, search };
}
