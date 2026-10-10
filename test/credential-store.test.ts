import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { CredentialStore } from "../src/runner/credentials/store.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";

let db: DatabaseSync;
let store: CredentialStore;

beforeEach(() => {
  db = openSqlite(":memory:", runnerMigrations);
  store = new CredentialStore(db);
});

afterEach(() => {
  db.close();
});

const base: CredentialRuntimeState = {
  // 版本每次写入恰好 +1：初始为 0，故首次写入必须为 1。
  version: 1,
  pools: [{ id: "tavily-main", service: "tavily", name: "Tavily 主池", enabled: true }],
  credentials: [
    {
      id: "key-1",
      poolId: "tavily-main",
      name: "primary",
      secret: "tvly-supersecretvalue",
      enabled: true,
      accountGroup: "acct-a",
      createdAt: 1,
    },
    {
      id: "key-2",
      poolId: "tavily-main",
      name: "backup",
      secret: "tvly-anothersecret00",
      enabled: false,
      createdAt: 2,
    },
  ],
  bindings: { tavily: "tavily-main" },
  state: { "key-1": { availability: "cooling", cooldownUntil: 999 } },
};

describe("CredentialStore", () => {
  it("round-trips credentials, bindings and persisted availability", () => {
    store.write(base);
    const read = store.read();

    expect(read.version).toBe(1);
    expect(read.bindings).toEqual({ tavily: "tavily-main" });
    expect(read.state["key-1"]).toMatchObject({ availability: "cooling", cooldownUntil: 999 });
    expect(read.credentials.map((credential) => credential.id)).toEqual(["key-1", "key-2"]);
    expect(read.credentials[0]?.secret).toBe("tvly-supersecretvalue");
    expect(read.credentials[1]?.enabled).toBe(false);
    expect(read.pools[0]).toMatchObject({ id: "tavily-main", service: "tavily" });
  });

  it("never returns a full secret through the safe view", () => {
    store.write(base);
    const safe = store.safeView();
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain("tvly-supersecretvalue");
    expect(serialized).not.toContain("tvly-anothersecret00");
    expect(safe.credentials[0]?.maskedSecret).toContain("****");
    expect(safe.credentials[0]?.maskedSecret.startsWith("tvly-s")).toBe(true);
    expect(safe.credentials[0]).toMatchObject({ enabled: true, accountGroup: "acct-a" });
    expect(safe.pools[0]?.providerRefs).toEqual(["tavily"]);
    expect(safe.version).toBe(1);
  });

  it("rejects a version rollback", () => {
    store.write(base);
    expect(() => store.write({ ...base, version: 0 })).toThrowError(/version/i);
  });

  it("rejects a version that skips ahead", () => {
    store.write(base);
    // 当前为 1，下一个合法版本是 2；跳到 3 必须拒绝。
    expect(() => store.write({ ...base, version: 3 })).toThrowError(/version/i);
  });

  it("rejects bindings pointing at unknown pools", () => {
    expect(() => store.write({ ...base, bindings: { tavily: "missing-pool" } })).toThrowError(/pool/i);
  });

  it("rejects credentials assigned to an unknown pool", () => {
    expect(() => store.write({
      ...base,
      credentials: [{ ...base.credentials[0]!, poolId: "missing-pool" }],
    })).toThrowError(/pool/i);
  });

  it("persists an empty state without inventing pools", () => {
    store.write({
      version: 1,
      pools: [],
      credentials: [],
      bindings: {},
      state: {},
    });

    expect(store.read()).toMatchObject({ version: 1, pools: [], credentials: [], bindings: {}, state: {} });
    expect(store.safeView().credentials).toEqual([]);
  });

  it("treats a missing pool as no binding rather than a crash", () => {
    store.write(base);
    expect(store.safeView().providers).toEqual([{ id: "tavily", poolId: "tavily-main" }]);
  });
});
