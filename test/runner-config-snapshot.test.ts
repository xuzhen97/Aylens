import { describe, expect, it } from "vitest";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";
import { runnerConfigSchema } from "../src/runner/config.js";
import { ProxyConfigStore } from "../src/runner/proxy-config-store.js";
import { ProxyConfigService } from "../src/runner/proxy-config-service.js";
import { buildExecutionSnapshot } from "../src/runner/execution-snapshot.js";
import { TransportRegistry } from "../src/transports/registry.js";
import { BrowserProfileManager } from "../src/browser/profile-manager.js";
import { ChromeProfileHost } from "../src/browser/chrome-profile-host.js";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return runnerConfigSchema.parse({
    runner: { id: "r", token: "t", gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect" },
    ...overrides,
  });
}

function makeSnapshotHarness() {
  const db = openSqlite(":memory:", runnerMigrations);
  const store = new ProxyConfigStore(db);
  const config = baseConfig({
    transports: {
      "proxy-main": { type: "http-proxy", url: "http://127.0.0.1:8899" },
    },
    browserProfiles: {
      "browser-main": {
        mode: "cdp",
        userDataDir: "D:/profiles/main",
        cdpEndpoint: "http://127.0.0.1:9222",
        autoStart: true,
      },
    },
    providers: {
      "url-fetch": { type: "url-fetch", transport: { primary: "proxy-main" } },
    },
  });
  store.initialize(config);  const service = new ProxyConfigService(store, config);
  const sharedBrowser = new ChromeProfileHost(new BrowserProfileManager(), new TransportRegistry());
  return { db, service, config, sharedBrowser };
}

describe("buildExecutionSnapshot", () => {
  it("builds an isolated registry that does not mutate the previous snapshot", () => {
    const { db, service, config, sharedBrowser } = makeSnapshotHarness();
    try {
      const before = buildExecutionSnapshot(service.readState(), config, sharedBrowser);
      expect(before.transports.get("proxy-main")).toBeDefined();
      expect(before.transports.getConfig("proxy-main")).toMatchObject({ type: "http-proxy" });

      const state = service.readState();
      service.write({
        operationId: "op-2",
        expectedVersion: state.version,
        mutation: {
          kind: "put", id: "proxy-main", type: "http-proxy",
          address: "http://127.0.0.1:9999", credentials: { action: "clear" },
        },
      });

      const after = buildExecutionSnapshot(service.readState(), config, sharedBrowser);
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.transports).not.toBe(before.transports);
      // 旧快照仍读旧配置;新快照读新配置。
      expect(before.transports.getConfig("proxy-main")).toMatchObject({ type: "http-proxy" });
      expect(
        (before.transports.getConfig("proxy-main") as { url?: string }).url,
      ).not.toContain("9999");
      expect(
        (after.transports.getConfig("proxy-main") as { url?: string }).url,
      ).toContain("9999");
      // 共享浏览器宿主:facade 的原型是 sharedBrowser,生命周期与缓存共享。
      expect(Object.getPrototypeOf(after.browser)).toBe(sharedBrowser);
    } finally {
      db.close();
    }
  });

  it("produces deployments merged with current database bindings", () => {
    const { db, service, config, sharedBrowser } = makeSnapshotHarness();
    try {
      const state = service.readState();
      service.write({
        operationId: "op-unbind",
        expectedVersion: state.version,
        mutation: { kind: "bind", providerId: "url-fetch", binding: null },
      });

      const snapshot = buildExecutionSnapshot(service.readState(), config, sharedBrowser);
      expect(snapshot.deployments["url-fetch"]?.transport).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps a frozen deployment object per snapshot", () => {
    const { db, service, config, sharedBrowser } = makeSnapshotHarness();
    try {
      const snapshot = buildExecutionSnapshot(service.readState(), config, sharedBrowser);
      const deployment = snapshot.deployments["url-fetch"];
      expect(Object.isFrozen(deployment)).toBe(true);
      expect(Object.isFrozen(deployment?.transport)).toBe(true);
    } finally {
      db.close();
    }
  });
});
