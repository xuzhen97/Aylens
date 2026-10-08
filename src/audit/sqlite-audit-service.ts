import type { DatabaseSync } from "node:sqlite";
import type { AuditProviderEvent, AuditRecord } from "./audit-service.js";
import { toSafeRequest } from "./safe-request.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type RequestRow = {
  request_id: string;
  trace_id: string;
  request_json: string;
  created_at: number;
  completed_at: number | null;
  status: string;
};

type ProviderEventRow = {
  request_id: string;
  provider_id: string;
  runtime_id: string | null;
  started_at: number;
  completed_at: number;
  status: string;
  error_code: string | null;
  result_count: number;
};

function rowToRecord(request: AuditRecord["request"], row: RequestRow, events: ProviderEventRow[]): AuditRecord {
  return {
    requestId: row.request_id,
    traceId: row.trace_id,
    request,
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    status: row.status as AuditRecord["status"],
    providers: events.map((event) => ({
      providerId: event.provider_id,
      ...(event.runtime_id !== null ? { runtimeId: event.runtime_id } : {}),
      startedAt: event.started_at,
      completedAt: event.completed_at,
      status: event.status as AuditProviderEvent["status"],
      ...(event.error_code !== null ? { errorCode: event.error_code } : {}),
      resultCount: event.result_count,
    })),
  };
}

/**
 * 持久化审计服务:写入前脱敏,重启后仍可查询。
 * 与内存实现共享同一 AuditService 行为契约,但数据保存在 SQLite。
 */
export class SqliteAuditService {
  constructor(private readonly db: DatabaseSync) {}

  start(requestId: string, traceId: string, request: AuditRecord["request"]): void {
    // 只允许白名单字段进入存储;原始请求对象不落库。
    this.db.prepare(
      "INSERT INTO audit_requests (request_id, trace_id, request_json, created_at, status) VALUES (?, ?, ?, ?, 'running')",
    ).run(requestId, traceId, JSON.stringify(toSafeRequest(request)), Date.now());
  }

  addProviderEvent(requestId: string, event: AuditProviderEvent): void {
    this.db.prepare(
      "INSERT INTO audit_provider_events (request_id, provider_id, runtime_id, started_at, completed_at, status, error_code, result_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      requestId,
      event.providerId,
      event.runtimeId ?? null,
      event.startedAt,
      event.completedAt,
      event.status,
      event.errorCode ?? null,
      event.resultCount,
    );
  }

  finish(requestId: string, status: AuditRecord["status"]): void {
    this.db.prepare(
      "UPDATE audit_requests SET status = ?, completed_at = ? WHERE request_id = ?",
    ).run(status, Date.now(), requestId);
  }

  /** 启动恢复:遗留 running 请求统一标记为 interrupted。 */
  recoverInterrupted(now: number): void {
    this.db.prepare(
      "UPDATE audit_requests SET status = 'interrupted', completed_at = ? WHERE status = 'running'",
    ).run(now);
  }

  /** 分批清理过期记录(含 Provider 事件,级联删除),返回删除的请求数。 */
  pruneExpired(now: number, batchSize = 200): number {
    const cutoff = now - RETENTION_MS;
    // 过期以完成时间为准;未完成的历史请求按 created_at 判断,避免永不清理。
    const expired = this.db.prepare(`
      SELECT request_id FROM audit_requests
      WHERE COALESCE(completed_at, created_at) < ?
      LIMIT ?
    `).all(cutoff, batchSize) as Array<{ request_id: string }>;
    if (expired.length === 0) return 0;

    const deleteEvents = this.db.prepare("DELETE FROM audit_provider_events WHERE request_id = ?");
    const deleteRequest = this.db.prepare("DELETE FROM audit_requests WHERE request_id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of expired) {
        deleteEvents.run(row.request_id);
        deleteRequest.run(row.request_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return expired.length;
  }

  list(limit = 50): AuditRecord[] {
    const safeLimit = Math.max(0, Math.min(Math.trunc(limit), 200));
    const rows = this.db.prepare(
      "SELECT * FROM audit_requests ORDER BY created_at DESC LIMIT ?",
    ).all(safeLimit) as RequestRow[];
    return rows.map((row) => this.loadRecord(row));
  }

  get(requestId: string): AuditRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM audit_requests WHERE request_id = ?",
    ).get(requestId) as RequestRow | undefined;
    return row ? this.loadRecord(row) : undefined;
  }

  private loadRecord(row: RequestRow): AuditRecord {
    const events = this.db.prepare(
      "SELECT * FROM audit_provider_events WHERE request_id = ? ORDER BY started_at ASC",
    ).all(row.request_id) as ProviderEventRow[];
    let request: AuditRecord["request"];
    try {
      request = JSON.parse(row.request_json) as AuditRecord["request"];
    } catch (error) {
      throw new Error(`Corrupted audit record for request ${row.request_id}`, { cause: error });
    }
    return rowToRecord(request, row, events);
  }
}
