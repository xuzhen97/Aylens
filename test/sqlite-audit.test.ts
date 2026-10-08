import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { toSafeRequest } from "../src/audit/safe-request.js";
import { SqliteAuditService } from "../src/audit/sqlite-audit-service.js";
import { ConfigOperationStore } from "../src/audit/config-operation-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function openAuditDb() {
  return openSqlite(":memory:", gatewayMigrations);
}

describe("toSafeRequest", () => {
  it("strips userinfo, query and fragment from http URLs and truncates", () => {
    const safe = toSafeRequest({
      query: "https://u:secret@example.com/path?q=secret#secret",
      limit: 5,
    });
    expect(safe.query).toBe("https://example.com/path");
    expect(safe.limit).toBe(5);
  });

  it("truncates ordinary queries to 500 characters", () => {
    const safe = toSafeRequest({ query: "x".repeat(600) });
    expect(safe.query).toHaveLength(500);
  });

  it("drops unknown request fields instead of persisting them", () => {
    const safe = toSafeRequest({ query: "hello", limit: 3 } as never);
    expect(Object.keys(safe).sort()).toEqual(["limit", "query"]);
  });
});

describe("SqliteAuditService", () => {
  it("stores only a sanitized request before any read API is called", () => {
    const db = openAuditDb();
    const audit = new SqliteAuditService(db);
    audit.start("r1", "t1", {
      query: "https://u:secret@example.com/path?q=secret#secret",
      limit: 5,
    });

    const row = db.prepare("SELECT request_json FROM audit_requests WHERE request_id = 'r1'").get() as {
      request_json: string;
    };
    expect(row.request_json).not.toContain("secret");
    expect(audit.get("r1")?.request.query).toBe("https://example.com/path");
    db.close();
  });

  it("persists provider events and survives reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aylens-audit-"));
    try {
      const path = join(dir, "audit.sqlite");
      const first = openSqlite(path, gatewayMigrations);
      const audit = new SqliteAuditService(first);
      audit.start("r2", "t2", { query: "hello" });
      audit.addProviderEvent("r2", {
        providerId: "p",
        runtimeId: "runner-1",
        startedAt: 1,
        completedAt: 2,
        status: "success",
        resultCount: 3,
      });
      audit.finish("r2", "completed");
      first.close();

      const second = openSqlite(path, gatewayMigrations);
      const reloaded = new SqliteAuditService(second);
      const record = reloaded.get("r2");
      expect(record?.status).toBe("completed");
      expect(record?.providers[0]).toMatchObject({
        providerId: "p",
        runtimeId: "runner-1",
        resultCount: 3,
      });
      expect(reloaded.list(10).map((entry: { requestId: string }) => entry.requestId)).toContain("r2");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks leftover running requests as interrupted on recovery", () => {
    const db = openAuditDb();
    const audit = new SqliteAuditService(db);
    audit.start("r3", "t3", { query: "hello" });
    audit.recoverInterrupted(1000);

    expect(audit.get("r3")?.status).toBe("interrupted");
    expect(audit.get("r3")?.completedAt).toBe(1000);
    db.close();
  });

  it("prunes expired records in batches including provider events", () => {
    const db = openAuditDb();
    const audit = new SqliteAuditService(db);
    audit.start("old", "t-old", { query: "hello" });
    audit.finish("old", "completed");
    // 将完成时间回拨到 31 天前。
    db.prepare("UPDATE audit_requests SET created_at = ?, completed_at = ? WHERE request_id = 'old'")
      .run(Date.now() - 31 * DAY_MS, Date.now() - 31 * DAY_MS);

    audit.start("fresh", "t-fresh", { query: "hello" });
    audit.finish("fresh", "completed");

    expect(audit.pruneExpired(Date.now(), 10)).toBe(1);
    expect(audit.get("old")).toBeUndefined();
    expect(audit.get("fresh")).toBeDefined();
    db.close();
  });

  it("keeps interrupted records until their retention window passes", () => {
    const db = openAuditDb();
    const audit = new SqliteAuditService(db);
    audit.start("stale", "t-stale", { query: "hello" });
    audit.recoverInterrupted(Date.now() - 40 * DAY_MS);

    expect(audit.pruneExpired(Date.now(), 10)).toBe(1);
    expect(audit.get("stale")).toBeUndefined();
    db.close();
  });
});

describe("ConfigOperationStore", () => {
  it("records intent once and upserts only the status afterwards", () => {
    const db = openAuditDb();
    const store = new ConfigOperationStore(db);
    store.record({ operationId: "op-1", runnerId: "r", target: "proxy-main", kind: "put", createdAt: 5 });
    store.record({ operationId: "op-1", runnerId: "r", target: "proxy-main", kind: "put", createdAt: 999, status: "succeeded" });

    const row = db.prepare("SELECT * FROM config_operations WHERE operation_id = 'op-1'").get() as {
      created_at: number;
      status: string;
    };
    expect(row.created_at).toBe(5);
    expect(row.status).toBe("succeeded");
    db.close();
  });

  it("marks leftover pending operations as unknown and prunes by age", () => {
    const db = openAuditDb();
    const store = new ConfigOperationStore(db);
    store.record({ operationId: "op-2", runnerId: "r", target: "proxy-main", kind: "put", createdAt: Date.now() - 1 * DAY_MS });
    store.recoverPending();
    expect(store.get("op-2")?.status).toBe("unknown");

    store.record({ operationId: "op-3", runnerId: "r", target: "proxy-main", kind: "put", createdAt: Date.now() - 40 * DAY_MS });
    expect(store.pruneExpired(Date.now(), 10)).toBe(1);
    expect(store.get("op-3")).toBeUndefined();
    expect(store.get("op-2")).toBeDefined();
    db.close();
  });
});
