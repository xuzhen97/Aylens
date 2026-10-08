import type { AppConfig } from "../config/schema.js";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "../storage/sqlite.js";
import { gatewayDbPath } from "../storage/paths.js";
import { gatewayMigrations } from "../storage/gateway-migrations.js";
import { ProviderRegistry } from "../providers/registry.js";
import { RuntimeRegistry } from "../runtime/registry.js";
import { RunnerSessionManager } from "../runtime/runner-session-manager.js";
import { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { type AuditService } from "../audit/audit-service.js";
import { SqliteAuditService } from "../audit/sqlite-audit-service.js";
import { ConfigOperationStore } from "../audit/config-operation-store.js";
import { RunnerConfigChannel } from "../runtime/runner-config-channel.js";
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
  audit: AuditService;
  configOperations: ConfigOperationStore;
  configChannel: RunnerConfigChannel;
  search: SearchService;
  /** 幂等关闭:释放数据库句柄与清理定时器;测试可不调用。 */
  close(): void;
}

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export function createGatewayContext(
  config: AppConfig,
  options: { database?: DatabaseSync } = {},
): GatewayContext {
  const providers = new ProviderRegistry();
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    providers.addDefinition(id, providerConfig);
  }

  const runtimes = new RuntimeRegistry(config.runtimeRegistry.offlineAfterMs);
  const runnerSessions = new RunnerSessionManager(config.runtimeRegistry.jobTimeoutMs);
  const dispatcher = new ExecutionDispatcher(providers, runtimes, runnerSessions);

  const database = options.database
    ?? openSqlite(gatewayDbPath(process.env, process.cwd()), gatewayMigrations);
  const audit = new SqliteAuditService(database);
  const configOperations = new ConfigOperationStore(database);

  // 启动恢复:遗留 running 请求标记中断,pending 配置操作标记 unknown。
  audit.recoverInterrupted(Date.now());
  configOperations.recoverPending();

  // 启动时清理一批过期记录;运行期间每 5 分钟再清理一批。
  audit.pruneExpired(Date.now());
  configOperations.pruneExpired(Date.now());
  const pruneTimer = setInterval(() => {
    audit.pruneExpired(Date.now());
    configOperations.pruneExpired(Date.now());
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pruneTimer);
    database.close();
  };

  const router = new ProviderRouter(config);
  const search = new SearchService(router, dispatcher, audit);
  const configChannel = new RunnerConfigChannel();

  return { config, providers, runtimes, runnerSessions, dispatcher, audit, configOperations, configChannel, search, close };
}
