import type { Migration } from "./sqlite.js";

/** Gateway 本地库:脱敏请求审计、Provider 执行事件与脱敏配置操作记录。 */
export const gatewayMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE audit_requests (
        request_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL
      );
      CREATE INDEX idx_audit_requests_created_at ON audit_requests(created_at);

      CREATE TABLE audit_provider_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES audit_requests(request_id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        runtime_id TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        result_count INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_provider_events_request ON audit_provider_events(request_id);

      CREATE TABLE config_operations (
        operation_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX idx_config_operations_created_at ON config_operations(created_at);
    `,
  },
  {
    // Provider 启用态覆盖层：只存与配置文件的偏离，见
    // docs/adr/2026-10-10-runtime-provider-enablement.md。
    version: 2,
    sql: `
      CREATE TABLE provider_settings (
        provider_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
