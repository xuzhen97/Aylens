import type { Migration } from "./sqlite.js";

/**
 * Runner 本地库:代理配置与 Provider 传输绑定的权威存储。
 * 代理 URL(含凭据)只保存在本表的 url 字段,不进入任何日志或上报。
 */
export const runnerMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE proxy_transports (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        url TEXT NOT NULL
      );

      CREATE TABLE provider_transport_bindings (
        provider_id TEXT PRIMARY KEY,
        primary_id TEXT REFERENCES proxy_transports(id)
      );

      CREATE TABLE provider_transport_fallbacks (
        provider_id TEXT NOT NULL REFERENCES provider_transport_bindings(provider_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        transport_id TEXT NOT NULL REFERENCES proxy_transports(id),
        PRIMARY KEY (provider_id, position)
      );

      CREATE TABLE proxy_config_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        initialized INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        last_operation_id TEXT
      );
      INSERT INTO proxy_config_meta (id, initialized, version) VALUES (1, 0, 0);
    `,
  },
  {
    // API 凭据池:与代理配置独立的所有权边界,但共用同一个 Runner 数据库。
    // secret 是唯一明文秘密字段,绝不出现在任何读取接口或日志中;
    // secret_hash 用于安全检测重复登记同一把 Key,避免虚构出额外并发容量。
    // 见 docs/adr/2026-10-09-runner-api-credential-management.md。
    version: 2,
    sql: `
      CREATE TABLE api_credential_pools (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE api_credentials (
        id TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL REFERENCES api_credential_pools(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        account_group TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_api_credentials_pool ON api_credentials(pool_id);
      CREATE UNIQUE INDEX idx_api_credentials_secret_hash ON api_credentials(secret_hash);

      CREATE TABLE provider_credential_bindings (
        provider_id TEXT PRIMARY KEY,
        pool_id TEXT REFERENCES api_credential_pools(id) ON DELETE RESTRICT
      );

      CREATE TABLE api_credential_state (
        credential_id TEXT PRIMARY KEY REFERENCES api_credentials(id) ON DELETE CASCADE,
        availability TEXT NOT NULL,
        cooldown_until INTEGER,
        last_failure_category TEXT,
        last_success_at INTEGER
      );

      CREATE TABLE api_credential_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        last_operation_id TEXT
      );
      INSERT INTO api_credential_meta (id, version) VALUES (1, 0);
    `,
  },
];
