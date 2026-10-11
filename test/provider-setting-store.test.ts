import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { ProviderSettingStore } from "../src/providers/provider-setting-store.js";

describe("ProviderSettingStore", () => {
  it("stores an override, overwrites it, and refreshes updated_at", () => {
    const db = openSqlite(":memory:", gatewayMigrations);
    const store = new ProviderSettingStore(db);

    // 空库意味着"没有任何覆盖"，即全部跟随配置文件。
    expect(store.loadAll()).toEqual([]);

    store.set("tavily", false, 1000);
    expect(store.loadAll()).toEqual([{ providerId: "tavily", enabled: false, updatedAt: 1000 }]);

    store.set("tavily", true, 2000);
    expect(store.loadAll()).toEqual([{ providerId: "tavily", enabled: true, updatedAt: 2000 }]);

    db.close();
  });

  it("clears an override so the row disappears entirely", () => {
    const db = openSqlite(":memory:", gatewayMigrations);
    const store = new ProviderSettingStore(db);

    store.set("tavily", false, 1000);
    store.clear("tavily");

    expect(store.loadAll()).toEqual([]);
    db.close();
  });

  it("persists overrides across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "aylens-provider-settings-"));
    const path = join(dir, "gateway.db");
    try {
      const first = openSqlite(path, gatewayMigrations);
      new ProviderSettingStore(first).set("tavily", false, 1000);
      first.close();

      const second = openSqlite(path, gatewayMigrations);
      expect(new ProviderSettingStore(second).loadAll()).toEqual([
        { providerId: "tavily", enabled: false, updatedAt: 1000 },
      ]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
