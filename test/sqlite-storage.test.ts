import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inTransaction,
  openSqlite,
  type Migration,
} from "../src/storage/sqlite.js";
import { gatewayDbPath, runnerDbPath } from "../src/storage/paths.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";

const sampleMigration: Migration = {
  version: 1,
  sql: "CREATE TABLE sample(id TEXT PRIMARY KEY)",
};

describe("openSqlite", () => {
  it("runs each migration exactly once and reports foreign_keys enabled", () => {
    const db = openSqlite(":memory:", [sampleMigration]);
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    db.close();
  });

  it("rejects a database whose stored version is newer than the program", () => {
    const dir = mkdtempSync(join(tmpdir(), "aylens-sqlite-newer-"));
    const path = join(dir, "future.sqlite");
    try {
      const db = openSqlite(path, [{ version: 5, sql: "CREATE TABLE future(id INTEGER)" }]);
      db.close();

      expect(() => openSqlite(path, [sampleMigration])).toThrow(/newer/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reopens a file database with existing migrations applied and creates parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aylens-sqlite-"));
    try {
      const path = join(dir, "nested", "data.sqlite");
      const first = openSqlite(path, [sampleMigration]);
      inTransaction(first, () => {
        first.prepare("INSERT INTO sample VALUES (?)").run("kept");
      });
      first.close();

      const second = openSqlite(path, [sampleMigration]);
      expect(second.prepare("SELECT id FROM sample").get()).toMatchObject({ id: "kept" });
      second.close();

      const stat = await readFile(path);
      expect(stat.byteLength).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on a corrupted database without overwriting the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aylens-sqlite-"));
    const path = join(dir, "broken.sqlite");
    try {
      await (await import("node:fs/promises")).writeFile(path, "definitely not a sqlite file");
      expect(() => openSqlite(path, [sampleMigration])).toThrow();
      expect(await readFile(path, "utf8")).toBe("definitely not a sqlite file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("inTransaction", () => {
  it("rolls back on failure and commits on success", () => {
    const db = openSqlite(":memory:", [sampleMigration]);
    expect(() => inTransaction(db, () => {
      db.prepare("INSERT INTO sample VALUES (?)").run("one");
      throw new Error("injected failure");
    })).toThrow("injected failure");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sample").get()).toMatchObject({ n: 0 });

    inTransaction(db, () => {
      db.prepare("INSERT INTO sample VALUES (?)").run("two");
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sample").get()).toMatchObject({ n: 1 });
    db.close();
  });
});

describe("gateway migrations", () => {
  it("creates audit and config operation tables", () => {
    const db = openSqlite(":memory:", gatewayMigrations);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    expect(names).toContain("audit_requests");
    expect(names).toContain("audit_provider_events");
    expect(names).toContain("config_operations");
    db.close();
  });
});

describe("runner migrations", () => {
  it("creates proxy transport tables with a fresh meta row", () => {
    const db = openSqlite(":memory:", runnerMigrations);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    expect(names).toContain("proxy_transports");
    expect(names).toContain("provider_transport_bindings");
    expect(names).toContain("provider_transport_fallbacks");
    expect(names).toContain("proxy_config_meta");
    expect(db.prepare("SELECT initialized, version FROM proxy_config_meta WHERE id = 1").get())
      .toMatchObject({ initialized: 0, version: 0 });
    db.close();
  });
});

describe("paths", () => {
  it("derives gateway and runner database paths from the environment", () => {
    expect(gatewayDbPath({ AYLENS_GATEWAY_DB: "D:\\custom\\gw.sqlite" }, "D:\\cwd"))
      .toBe("D:\\custom\\gw.sqlite");
    expect(gatewayDbPath({}, "D:\\cwd")).toBe(join("D:\\cwd", ".data", "gateway.sqlite"));
    expect(runnerDbPath("dev runner", {}, "D:\\cwd"))
      .toBe(join("D:\\cwd", ".data", "runners", "dev%20runner.sqlite"));
    expect(runnerDbPath("r1", { AYLENS_RUNNER_DB: "D:\\custom\\runner.sqlite" }, "D:\\cwd"))
      .toBe("D:\\custom\\runner.sqlite");
  });
});
