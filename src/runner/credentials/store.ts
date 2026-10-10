import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../../storage/sqlite.js";
import type {
  CredentialRuntimeState,
  SafeCredentialConfig,
} from "./types.js";

type PoolRow = { id: string; service: string; name: string; enabled: number };
type CredentialRow = {
  id: string;
  pool_id: string;
  name: string;
  secret: string;
  enabled: number;
  account_group: string | null;
  created_at: number;
};
type BindingRow = { provider_id: string; pool_id: string | null };
type StateRow = {
  credential_id: string;
  availability: string;
  cooldown_until: number | null;
  last_failure_category: string | null;
  last_success_at: number | null;
};
type MetaRow = { version: number; last_operation_id: string | null };

/** 供重复检测：不保存原文用于比对，只存哈希（同一 secret 哈希必然相同）。 */
export function credentialSecretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * API 凭据权威存储。
 *
 * - 明文 secret 只进不出：`read()` 给进程内快照，`safeView()` 才是对外唯一形态；
 * - 所有写入在单事务内完成，版本恰好 +1，任何校验失败都完整回滚；
 * - 与代理配置共用同一个 Runner 数据库，但所有权与表完全独立。
 */
export class CredentialStore {
  constructor(private readonly db: DatabaseSync) {}

  read(): CredentialRuntimeState {
    const meta = this.db.prepare(
      "SELECT version, last_operation_id FROM api_credential_meta WHERE id = 1",
    ).get() as MetaRow | undefined;
    if (!meta) throw new Error("Credential meta row is missing; runner database was not migrated");

    const pools = (this.db.prepare(
      "SELECT id, service, name, enabled FROM api_credential_pools ORDER BY id",
    ).all() as PoolRow[]).map((row) => ({
      id: row.id,
      service: row.service,
      name: row.name,
      enabled: row.enabled === 1,
    }));

    const credentials = (this.db.prepare(
      "SELECT id, pool_id, name, secret, enabled, account_group, created_at FROM api_credentials ORDER BY id",
    ).all() as CredentialRow[]).map((row) => ({
      id: row.id,
      poolId: row.pool_id,
      name: row.name,
      secret: row.secret,
      enabled: row.enabled === 1,
      ...(row.account_group !== null ? { accountGroup: row.account_group } : {}),
      createdAt: row.created_at,
    }));

    const bindings: Record<string, string | null> = {};
    for (const row of this.db.prepare(
      "SELECT provider_id, pool_id FROM provider_credential_bindings",
    ).all() as BindingRow[]) {
      bindings[row.provider_id] = row.pool_id;
    }

    const state: CredentialRuntimeState["state"] = {};
    for (const row of this.db.prepare(
      "SELECT credential_id, availability, cooldown_until, last_failure_category, last_success_at FROM api_credential_state",
    ).all() as StateRow[]) {
      state[row.credential_id] = {
        availability: row.availability as CredentialRuntimeState["state"][string]["availability"],
        ...(row.cooldown_until !== null ? { cooldownUntil: row.cooldown_until } : {}),
        ...(row.last_failure_category !== null
          ? { lastFailureCategory: row.last_failure_category as CredentialRuntimeState["state"][string]["lastFailureCategory"] }
          : {}),
        ...(row.last_success_at !== null ? { lastSuccessAt: row.last_success_at } : {}),
      };
    }

    return {
      version: meta.version,
      pools,
      credentials,
      bindings,
      state,
      ...(meta.last_operation_id !== null ? { lastOperationId: meta.last_operation_id } : {}),
    };
  }

  /**
   * 提交新状态。校验与写入在同一事务内：
   * 版本不是当前值 +1、引用了不存在的池、或违反唯一 secret —— 都整体回滚。
   */
  write(next: CredentialRuntimeState): void {
    inTransaction(this.db, () => {
      const meta = this.db.prepare(
        "SELECT version FROM api_credential_meta WHERE id = 1",
      ).get() as MetaRow;
      const expected = meta.version + 1;
      if (next.version !== expected) {
        throw new Error(
          `Credential config version conflict: expected ${expected}, current ${meta.version}, got ${next.version}`,
        );
      }

      const poolIds = new Set(next.pools.map((pool) => pool.id));
      const seenPoolIds = new Set<string>();
      for (const pool of next.pools) {
        if (seenPoolIds.has(pool.id)) throw new Error(`Duplicate credential pool id: ${pool.id}`);
        seenPoolIds.add(pool.id);
        if (!pool.service.trim()) throw new Error(`Credential pool requires a service: ${pool.id}`);
      }

      const seenCredentialIds = new Set<string>();
      for (const credential of next.credentials) {
        if (seenCredentialIds.has(credential.id)) throw new Error(`Duplicate credential id: ${credential.id}`);
        seenCredentialIds.add(credential.id);
        if (!poolIds.has(credential.poolId)) {
          throw new Error(`Credential ${credential.id} references unknown pool: ${credential.poolId}`);
        }
      }

      for (const [providerId, poolId] of Object.entries(next.bindings)) {
        if (poolId !== null && !poolIds.has(poolId)) {
          throw new Error(`Provider ${providerId} references unknown pool: ${poolId}`);
        }
      }

      for (const credentialId of Object.keys(next.state)) {
        if (!seenCredentialIds.has(credentialId)) {
          throw new Error(`Credential state references unknown credential: ${credentialId}`);
        }
      }

      // 删除顺序受外键约束：state/credentials 依赖池，bindings 对池是 RESTRICT。
      this.db.exec("DELETE FROM api_credential_state");
      this.db.exec("DELETE FROM api_credentials");
      this.db.exec("DELETE FROM provider_credential_bindings");
      this.db.exec("DELETE FROM api_credential_pools");

      const insertPool = this.db.prepare(
        "INSERT INTO api_credential_pools (id, service, name, enabled) VALUES (?, ?, ?, ?)",
      );
      for (const pool of next.pools) {
        insertPool.run(pool.id, pool.service, pool.name, pool.enabled ? 1 : 0);
      }

      const insertCredential = this.db.prepare(
        "INSERT INTO api_credentials (id, pool_id, name, secret, secret_hash, enabled, account_group, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const credential of next.credentials) {
        insertCredential.run(
          credential.id,
          credential.poolId,
          credential.name,
          credential.secret,
          credentialSecretHash(credential.secret),
          credential.enabled ? 1 : 0,
          credential.accountGroup ?? null,
          credential.createdAt,
        );
      }

      const insertBinding = this.db.prepare(
        "INSERT INTO provider_credential_bindings (provider_id, pool_id) VALUES (?, ?)",
      );
      for (const [providerId, poolId] of Object.entries(next.bindings)) {
        insertBinding.run(providerId, poolId);
      }

      const insertState = this.db.prepare(
        "INSERT INTO api_credential_state (credential_id, availability, cooldown_until, last_failure_category, last_success_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [credentialId, entry] of Object.entries(next.state)) {
        insertState.run(
          credentialId,
          entry.availability,
          entry.cooldownUntil ?? null,
          entry.lastFailureCategory ?? null,
          entry.lastSuccessAt ?? null,
        );
      }

      this.db.prepare(
        "UPDATE api_credential_meta SET version = ?, last_operation_id = ? WHERE id = 1",
      ).run(next.version, next.lastOperationId ?? null);
    });
  }

  /**
   * 对外唯一安全形态。掩码后即使整段序列化也不会泄漏明文。
   * 只输出白名单字段：不返回 secret，也不返回 secret_hash。
   */
  safeView(): SafeCredentialConfig {
    const state = this.read();
    const bindingsByPool = new Map<string, string[]>();
    for (const [providerId, poolId] of Object.entries(state.bindings)) {
      if (poolId === null) continue;
      const refs = bindingsByPool.get(poolId) ?? [];
      refs.push(providerId);
      bindingsByPool.set(poolId, refs);
    }

    const credentialCount = new Map<string, number>();
    for (const credential of state.credentials) {
      credentialCount.set(credential.poolId, (credentialCount.get(credential.poolId) ?? 0) + 1);
    }

    return {
      version: state.version,
      ...(state.lastOperationId !== undefined ? { lastOperationId: state.lastOperationId } : {}),
      pools: state.pools.map((pool) => ({
        ...pool,
        credentialCount: credentialCount.get(pool.id) ?? 0,
        providerRefs: bindingsByPool.get(pool.id) ?? [],
      })),
      credentials: state.credentials.map((credential) => {
        const entry = state.state[credential.id];
        return {
          id: credential.id,
          poolId: credential.poolId,
          name: credential.name,
          enabled: credential.enabled,
          ...(credential.accountGroup !== undefined ? { accountGroup: credential.accountGroup } : {}),
          maskedSecret: this.maskSecret(credential.secret),
          availability: entry?.availability ?? "unknown",
          ...(entry?.cooldownUntil !== undefined ? { cooldownUntil: entry.cooldownUntil } : {}),
          ...(entry?.lastFailureCategory !== undefined ? { lastFailureCategory: entry.lastFailureCategory } : {}),
          ...(entry?.lastSuccessAt !== undefined ? { lastSuccessAt: entry.lastSuccessAt } : {}),
        };
      }),
      providers: Object.entries(state.bindings).map(([id, poolId]) => ({ id, poolId })),
    };
  }

  /** 太短的值不保留任何片段，避免掩码后仍可猜出全文。 */
  maskSecret(secret: string): string {
    if (secret.length <= 10) return "****";
    return `${secret.slice(0, 6)}****${secret.slice(-4)}`;
  }
}
