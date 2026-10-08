import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 一次结构迁移:以 PRAGMA user_version 记录已应用的最高版本。 */
export interface Migration {
  readonly version: number;
  readonly sql: string;
}

function applyMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const highest = sorted.at(-1)?.version ?? 0;
  if (current > highest) {
    db.close();
    throw new Error(
      `SQLite database is newer than this program: stored version ${current}, program knows up to ${highest}`,
    );
  }

  for (const migration of sorted) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw new Error(`SQLite migration ${migration.version} failed`, { cause: error });
    }
  }
}

/**
 * 打开数据库并应用版本化迁移。
 *
 * - `:memory:` 用于测试;文件库会先创建父目录并收紧权限。
 * - foreign_keys 与 busy_timeout 固定开启,文件库使用 WAL。
 * - 打开或迁移失败时立即抛错,绝不静默退回空库。
 */
export function openSqlite(path: string, migrations: readonly Migration[]): DatabaseSync {
  if (path !== ":memory:") {
    // 父目录必须在打开前同步存在;权限收紧是尽力而为(Windows 上 chmod 仅部分生效,由部署文档说明 ACL)。
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create SQLite database directory: ${dirname(path)}`, { cause: error });
    }
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // Windows 文件系统上 POSIX 权限不生效;部署文档要求用 ACL 保护目录。
    }
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    // 打开或初始化失败必须释放句柄,否则 Windows 上文件被锁,无法清理或替换。
    try {
      db?.close();
    } catch { /* already closed */ }
    throw new Error(`Failed to open SQLite database: ${path}`, { cause: error });
  }

  applyMigrations(db, migrations);
  return db;
}

/** 在 IMMEDIATE 事务中执行工作;任何失败都完整回滚并原样抛出。 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
