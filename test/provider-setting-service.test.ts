import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderSettingStore } from "../src/providers/provider-setting-store.js";
import {
  ProviderNotFoundError,
  ProviderSettingService,
} from "../src/providers/provider-setting-service.js";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";

let db: DatabaseSync;
let registry: ProviderRegistry;
let store: ProviderSettingStore;
let service: ProviderSettingService;

beforeEach(() => {
  db = openSqlite(":memory:", gatewayMigrations);
  store = new ProviderSettingStore(db);
  registry = new ProviderRegistry();
  registry.addDefinition("tavily", { type: "tavily", enabled: false });
  registry.addDefinition("url-fetch", { type: "url-fetch", enabled: true });
  service = new ProviderSettingService(registry, store, () => 5000);
});

describe("ProviderSettingService", () => {
  it("writes the override and reports the effective state", () => {
    expect(service.setMode("tavily", "enabled")).toEqual({
      providerId: "tavily",
      enabled: true,
      enabledMode: "enabled",
      enabledSource: "override",
    });
    expect(store.loadAll()).toEqual([{ providerId: "tavily", enabled: true, updatedAt: 5000 }]);
    // 生效值确实变了：registry 不再抛 PROVIDER_DISABLED。
    expect(registry.getDefinition("tavily").id).toBe("tavily");
    db.close();
  });

  it("returns to the config value in config mode", () => {
    service.setMode("tavily", "enabled");
    const state = service.setMode("tavily", "config");
    expect(state).toEqual({
      providerId: "tavily",
      enabled: false,
      enabledMode: "config",
      enabledSource: "config",
    });
    expect(store.loadAll()).toEqual([]);
    db.close();
  });

  it("can re-enable a provider that is currently disabled", () => {
    // INV-1 端到端：先禁用，再从禁用态启用回来。
    service.setMode("url-fetch", "disabled");
    expect(() => registry.getDefinition("url-fetch")).toThrowError(/disabled/i);
    expect(service.setMode("url-fetch", "enabled").enabled).toBe(true);
    expect(registry.getDefinition("url-fetch").id).toBe("url-fetch");
    db.close();
  });

  it("rejects an unknown provider without touching the store", () => {
    expect(() => service.setMode("ghost", "disabled")).toThrowError(ProviderNotFoundError);
    expect(store.loadAll()).toEqual([]);
    db.close();
  });

  it("does not change the in-memory state when the store write fails", () => {
    // INV-5：磁盘失败必须原样暴露，且不能留下"界面说已禁用、实际还在跑"的假象。
    const failing = {
      loadAll: () => [],
      set: () => { throw new Error("disk is on fire"); },
      clear: () => { throw new Error("disk is on fire"); },
    } as unknown as ProviderSettingStore;
    const guarded = new ProviderSettingService(registry, failing, () => 5000);

    expect(() => guarded.setMode("url-fetch", "disabled")).toThrowError(/disk is on fire/);
    expect(registry.list().find((item) => item.id === "url-fetch"))
      .toMatchObject({ enabled: true, enabledMode: "config" });
    db.close();
  });
});

describe("GatewayContext provider settings assembly", () => {
  it("loads persisted overrides at boot", () => {
    const database = openSqlite(":memory:", gatewayMigrations);
    // 模拟"上一次运行留下了一条禁用覆盖"。
    new ProviderSettingStore(database).set("url-fetch", false, 1000);

    const config = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
      auth: { apiKey: "admin-test-key", runnerTokens: {} },
      providers: { "url-fetch": { type: "url-fetch", enabled: true } },
      routes: { default: { providers: ["url-fetch"] } },
    });

    const context = createGatewayContext(config, { database });
    expect(context.providers.list().find((item) => item.id === "url-fetch"))
      .toMatchObject({ enabled: false, enabledMode: "disabled" });
    context.close();
  });
});
