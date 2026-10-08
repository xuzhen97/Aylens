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
];
