import type { DatabaseSync } from "node:sqlite";
import type { RunnerConfig } from "../runner/config.js";
import { inTransaction } from "../storage/sqlite.js";
import type { ProxyConfigState, ProviderTransportBinding } from "../runtime/proxy-config-contract.js";

type TransportRow = { id: string; type: string; url: string };
type BindingRow = { provider_id: string; primary_id: string | null };
type FallbackRow = { provider_id: string; position: number; transport_id: string };
type MetaRow = { initialized: number; version: number; last_operation_id: string | null };

/**
 * Runner 权威配置存储:代理与 Provider 传输绑定的唯一事实来源。
 * 私密 URL 只保存在 proxy_transports.url,不进入日志或上报。
 */
export class ProxyConfigStore {
  constructor(private readonly db: DatabaseSync) {}

  read(): ProxyConfigState {
    const meta = this.db.prepare(
      "SELECT initialized, version, last_operation_id FROM proxy_config_meta WHERE id = 1",
    ).get() as MetaRow;

    const transports: ProxyConfigState["transports"] = {};
    for (const row of this.db.prepare("SELECT id, type, url FROM proxy_transports").all() as TransportRow[]) {
      // direct 无 URL;数据库中以空串存储,读出时归一为 schema 形态。
      if (row.type === "direct") {
        transports[row.id] = { type: "direct" };
      } else {
        transports[row.id] = { type: row.type as "http-proxy" | "socks5", url: row.url };
      }
    }

    const bindings: ProxyConfigState["bindings"] = {};
    const fallbacks = this.db.prepare(
      "SELECT provider_id, position, transport_id FROM provider_transport_fallbacks ORDER BY provider_id, position",
    ).all() as FallbackRow[];
    const fallbackByProvider = new Map<string, string[]>();
    for (const row of fallbacks) {
      const list = fallbackByProvider.get(row.provider_id) ?? [];
      list.push(row.transport_id);
      fallbackByProvider.set(row.provider_id, list);
    }

    for (const row of this.db.prepare(
      "SELECT provider_id, primary_id FROM provider_transport_bindings",
    ).all() as BindingRow[]) {
      bindings[row.provider_id] = row.primary_id === null
        ? null
        : { primary: row.primary_id, fallback: fallbackByProvider.get(row.provider_id) ?? [] };
    }

    return {
      version: meta.version,
      initialized: meta.initialized === 1,
      transports,
      bindings,
      ...(meta.last_operation_id !== null ? { lastOperationId: meta.last_operation_id } : {}),
    };
  }

  /**
   * 首次初始化:在同一事务中导入 YAML 代理、绑定并标记完成。
   * 已初始化时为幂等空操作——数据库是唯一来源,YAML 不再覆盖。
   */
  initialize(config: RunnerConfig): void {
    const meta = this.db.prepare(
      "SELECT initialized FROM proxy_config_meta WHERE id = 1",
    ).get() as { initialized: number };
    if (meta.initialized === 1) return;

    inTransaction(this.db, () => {
      const insertTransport = this.db.prepare(
        "INSERT OR REPLACE INTO proxy_transports (id, type, url) VALUES (?, ?, ?)",
      );
      // 内置 direct 始终存在且不可删除,不依赖 YAML transports 段是否出现。
      insertTransport.run("direct", "direct", "");
      for (const [id, transport] of Object.entries(config.transports)) {
        if (transport.type === "direct") {
          insertTransport.run(id, "direct", "");
        } else {
          insertTransport.run(id, transport.type, transport.url);
        }
      }

      const insertBinding = this.db.prepare(
        "INSERT OR REPLACE INTO provider_transport_bindings (provider_id, primary_id) VALUES (?, ?)",
      );
      const insertFallback = this.db.prepare(
        "INSERT OR REPLACE INTO provider_transport_fallbacks (provider_id, position, transport_id) VALUES (?, ?, ?)",
      );
      for (const [providerId, deployment] of Object.entries(config.providers)) {
        if (!deployment.transport) continue;
        insertBinding.run(providerId, deployment.transport.primary);
        deployment.transport.fallback.forEach((transportId, index) => {
          insertFallback.run(providerId, index, transportId);
        });
      }

      this.db.prepare(
        "UPDATE proxy_config_meta SET initialized = 1, version = 1 WHERE id = 1",
      ).run();
    });
  }

  /**
   * 提交新状态:校验期望版本,在同一事务中替换代理、绑定并递增版本。
   * 版本过期或事务失败都不改变任何持久化状态。
   */
  commit(
    next: ProxyConfigState,
    expectedVersion: number,
    operationId: string,
  ): void {
    inTransaction(this.db, () => {
      const meta = this.db.prepare(
        "SELECT version FROM proxy_config_meta WHERE id = 1",
      ).get() as { version: number };
      if (meta.version !== expectedVersion) {
        throw new Error(
          `Proxy config version conflict: expected ${expectedVersion}, current ${meta.version}`,
        );
      }

      this.db.exec("DELETE FROM provider_transport_fallbacks");
      this.db.exec("DELETE FROM provider_transport_bindings");
      this.db.exec("DELETE FROM proxy_transports");

      const insertTransport = this.db.prepare(
        "INSERT INTO proxy_transports (id, type, url) VALUES (?, ?, ?)",
      );
      insertTransport.run("direct", "direct", "");
      for (const [id, transport] of Object.entries(next.transports)) {
        if (id === "direct") continue;
        if (transport.type === "direct") {
          insertTransport.run(id, "direct", "");
        } else {
          insertTransport.run(id, transport.type, transport.url);
        }
      }

      const insertBinding = this.db.prepare(
        "INSERT INTO provider_transport_bindings (provider_id, primary_id) VALUES (?, ?)",
      );
      const insertFallback = this.db.prepare(
        "INSERT INTO provider_transport_fallbacks (provider_id, position, transport_id) VALUES (?, ?, ?)",
      );
      for (const [providerId, binding] of Object.entries(next.bindings)) {
        // null 绑定也写入一行,显式记录"无绑定"状态,避免回退到 YAML。
        insertBinding.run(providerId, binding === null ? null : binding.primary);
        if (binding !== null) {
          binding.fallback.forEach((transportId, index) => {
            insertFallback.run(providerId, index, transportId);
          });
        }
      }

      this.db.prepare(
        "UPDATE proxy_config_meta SET version = ?, last_operation_id = ? WHERE id = 1",
      ).run(expectedVersion + 1, operationId);
    });
  }
}

export type { ProviderTransportBinding };
