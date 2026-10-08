import type { DatabaseSync } from "node:sqlite";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ConfigOperationInput {
  operationId: string;
  runnerId: string;
  /** 仅代理 ID 或 Provider ID;禁止地址、mutation JSON 或任何秘密进入本表。 */
  target: string;
  kind: string;
  createdAt: number;
  /** 首次写入为 pending;后续 UPSERT 只允许更新结果状态。 */
  status?: "pending" | "succeeded" | "failed" | "unknown";
}

type OperationRow = {
  operation_id: string;
  runner_id: string;
  target: string;
  kind: string;
  created_at: number;
  status: string;
};

/** 脱敏配置操作记录:只存目标与结果,不存修改内容或凭据。 */
export class ConfigOperationStore {
  constructor(private readonly db: DatabaseSync) {}

  record(input: ConfigOperationInput): void {
    this.db.prepare(`
      INSERT INTO config_operations (operation_id, runner_id, target, kind, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET status = excluded.status
    `).run(
      input.operationId,
      input.runnerId,
      input.target,
      input.kind,
      input.createdAt,
      input.status ?? "pending",
    );
  }

  get(operationId: string): { operationId: string; runnerId: string; target: string; kind: string; createdAt: number; status: string } | undefined {
    const row = this.db.prepare(
      "SELECT * FROM config_operations WHERE operation_id = ?",
    ).get(operationId) as OperationRow | undefined;
    return row
      ? {
          operationId: row.operation_id,
          runnerId: row.runner_id,
          target: row.target,
          kind: row.kind,
          createdAt: row.created_at,
          status: row.status,
        }
      : undefined;
  }

  /** 启动恢复:遗留 pending 操作标记为 unknown,不宣称成功或失败。 */
  recoverPending(): void {
    this.db.prepare(
      "UPDATE config_operations SET status = 'unknown' WHERE status = 'pending'",
    ).run();
  }

  /** 分批清理过期操作记录,返回删除数量。 */
  pruneExpired(now: number, batchSize = 200): number {
    const cutoff = now - RETENTION_MS;
    const result = this.db.prepare(
      "DELETE FROM config_operations WHERE operation_id IN (SELECT operation_id FROM config_operations WHERE created_at < ? LIMIT ?)",
    ).run(cutoff, batchSize);
    return Number(result.changes);
  }
}
