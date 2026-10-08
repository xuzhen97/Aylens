import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";
import { ProxyConfigStore } from "../src/runner/proxy-config-store.js";
import { ProxyConfigService } from "../src/runner/proxy-config-service.js";
import { runnerConfigSchema } from "../src/runner/config.js";

function openRunnerDb() {
  return openSqlite(":memory:", runnerMigrations);
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return runnerConfigSchema.parse({
    runner: { id: "r", token: "t", gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect" },
    ...overrides,
  });
}

describe("ProxyConfigStore", () => {
  it("imports YAML transports and bindings once, then ignores YAML on restart", () => {
    const db = openRunnerDb();
    const store = new ProxyConfigStore(db);
    const config = baseConfig({
      transports: {
        direct: { type: "direct" },
        "proxy-us": { type: "http-proxy", url: "http://user:secret@proxy.example.com:8080" },
      },
      providers: {
        "url-fetch": { type: "url-fetch", transport: { primary: "proxy-us", fallback: ["direct"] } },
      },
    });

    store.initialize(config);
    const state = store.read();
    expect(state.initialized).toBe(true);
    expect(state.transports["proxy-us"]).toMatchObject({ type: "http-proxy" });
    expect(state.bindings["url-fetch"]).toEqual({ primary: "proxy-us", fallback: ["direct"] });
    expect(state.version).toBeGreaterThan(0);

    // 重启:显式清除绑定后,旧 YAML 不得把绑定写回来。
    store.commit({ ...state, bindings: { "url-fetch": null } }, state.version, "op-clear");
    store.initialize(config);
    expect(store.read().bindings["url-fetch"]).toBeNull();
    expect(store.read().transports.direct).toEqual({ type: "direct" });
    db.close();
  });

  it("never re-imports or overwrites stored proxy credentials from YAML", () => {
    const db = openRunnerDb();
    const store = new ProxyConfigStore(db);
    const config = baseConfig({
      transports: {
        "proxy-a": { type: "http-proxy", url: "http://user:old-secret@proxy-a.example.com:8080" },
      },
    });

    store.initialize(config);
    const state = store.read();
    store.commit({
      ...state,
      transports: {
        ...state.transports,
        "proxy-a": { type: "http-proxy", url: "http://user:new-secret@proxy-a.example.com:8080" },
      },
    }, state.version, "op-update");

    store.initialize(config);
    expect(store.read().transports["proxy-a"]).toEqual({
      type: "http-proxy",
      url: "http://user:new-secret@proxy-a.example.com:8080",
    });
    db.close();
  });

  it("rejects commit with a stale version and does not change state", () => {
    const db = openRunnerDb();
    const store = new ProxyConfigStore(db);
    store.initialize(baseConfig({
      transports: { "proxy-a": { type: "http-proxy", url: "http://127.0.0.1:8899" } },
    }));
    const state = store.read();

    expect(() => store.commit({
      ...state,
      transports: { ...state.transports, "proxy-b": { type: "socks5", url: "socks5://127.0.0.1:1080" } },
    }, state.version - 1, "op-stale")).toThrow(/version/i);

    expect(store.read().transports["proxy-b"]).toBeUndefined();
    db.close();
  });
});

describe("ProxyConfigService", () => {
  function makeService(config = baseConfig({
    transports: {
      "proxy-a": { type: "http-proxy", url: "http://user:secret@proxy-a.example.com:8080" },
    },
    browserProfiles: {
      "browser-main": {
        mode: "cdp",
        userDataDir: "D:/profiles/main",
        cdpEndpoint: "http://127.0.0.1:9222",
        autoStart: true,
        transport: "proxy-a",
      },
    },
    providers: {
      "url-fetch": { type: "url-fetch", transport: { primary: "proxy-a" } },
    },
  })) {
    const db = openRunnerDb();
    const store = new ProxyConfigStore(db);
    store.initialize(config);
    const service = new ProxyConfigService(store, config);
    return { db, store, service, config };
  }

  it("exposes a safe view without credentials or raw URLs", () => {
    const { db, service } = makeService();
    const safe = service.readSafe();

    const proxy = safe.proxies.find((entry) => entry.id === "proxy-a");
    expect(proxy).toMatchObject({ type: "http-proxy", hasCredentials: true });
    expect(proxy?.address).toBe("http://proxy-a.example.com:8080/");
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(safe.proxies.find((entry) => entry.id === "direct")).toMatchObject({ type: "direct" });
    expect(safe.browserRestartRequired).toContain("browser-main");
    db.close();
  });

  it("applies keep/replace/clear credential actions", () => {
    const { db, service } = makeService();
    const state = service.readSafe();

    // keep:只改地址,凭据保留。
    const kept = service.write({
      operationId: "op-keep",
      expectedVersion: state.version,
      mutation: {
        kind: "put", id: "proxy-a", type: "http-proxy",
        address: "http://proxy-a.example.com:9090", credentials: { action: "keep" },
      },
    });
    expect(kept.proxies.find((entry) => entry.id === "proxy-a")?.hasCredentials).toBe(true);

    // replace:换新凭据。
    const replaced = service.write({
      operationId: "op-replace",
      expectedVersion: kept.version,
      mutation: {
        kind: "put", id: "proxy-a", type: "http-proxy",
        address: "http://proxy-a.example.com:9090",
        credentials: { action: "replace", username: "user2", password: "secret2" },
      },
    });
    expect(replaced.proxies.find((entry) => entry.id === "proxy-a")?.hasCredentials).toBe(true);

    // clear:明确清除凭据。
    const cleared = service.write({
      operationId: "op-clear",
      expectedVersion: replaced.version,
      mutation: {
        kind: "put", id: "proxy-a", type: "http-proxy",
        address: "http://proxy-a.example.com:9090", credentials: { action: "clear" },
      },
    });
    expect(cleared.proxies.find((entry) => entry.id === "proxy-a")?.hasCredentials).toBe(false);
    db.close();
  });

  it("rejects invalid addresses, direct mutations, duplicate fallbacks and unknown references", () => {
    const { db, service } = makeService();
    const state = service.readSafe();
    const put = (id: string, address: string, version = state.version) => service.write({
      operationId: `op-${id}-${address}`,
      expectedVersion: version,
      mutation: { kind: "put", id, type: "http-proxy", address, credentials: { action: "clear" } },
    });

    expect(() => put("bad-userinfo", "http://user:pass@proxy.example.com:8080")).toThrow(/invalid/i);
    expect(() => put("bad-proto", "ftp://proxy.example.com:21")).toThrow(/invalid/i);
    expect(() => put("direct", "http://127.0.0.1:8899")).toThrow(/invalid/i);
    expect(() => service.write({
      operationId: "op-dup-fallback",
      expectedVersion: state.version,
      mutation: { kind: "bind", providerId: "url-fetch", binding: { primary: "proxy-a", fallback: ["proxy-a"] } },
    })).toThrow(/fallback/i);
    expect(() => service.write({
      operationId: "op-unknown-ref",
      expectedVersion: state.version,
      mutation: { kind: "bind", providerId: "url-fetch", binding: { primary: "missing", fallback: [] } },
    })).toThrow(/unknown transport/i);
    db.close();
  });

  it("refuses to delete a proxy referenced by a provider or browser profile", () => {
    const { db, service } = makeService();
    const state = service.readSafe();

    expect(() => service.write({
      operationId: "op-delete-used",
      expectedVersion: state.version,
      mutation: { kind: "delete", id: "proxy-a" },
    })).toThrow(/referenced/i);
    db.close();
  });

  it("binds and unbinds providers explicitly", () => {
    const { db, service } = makeService();
    const state = service.readSafe();

    const unbound = service.write({
      operationId: "op-unbind",
      expectedVersion: state.version,
      mutation: { kind: "bind", providerId: "url-fetch", binding: null },
    });
    expect(unbound.providers.find((entry) => entry.id === "url-fetch")?.binding).toBeNull();

    const rebound = service.write({
      operationId: "op-rebind",
      expectedVersion: unbound.version,
      mutation: { kind: "bind", providerId: "url-fetch", binding: { primary: "direct", fallback: ["proxy-a"] } },
    });
    expect(rebound.providers.find((entry) => entry.id === "url-fetch")?.binding).toEqual({
      primary: "direct",
      fallback: ["proxy-a"],
    });
    db.close();
  });

  it("imports credentials from legacy YAML userinfo instead of echoing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aylens-runner-config-"));
    try {
      const yamlPath = join(dir, "runner.yaml");
      await writeFile(yamlPath, [
        "runner:",
        "  id: legacy-runner",
        "  gatewayUrl: \"ws://127.0.0.1:3000/v1/runners/connect\"",
        "  token: dev-runner-token",
        "transports:",
        "  proxy-legacy:",
        "    type: http-proxy",
        "    url: \"http://legacy-user:legacy-secret@proxy.example.com:3128\"",
        "providers:",
        "  url-fetch:",
        "    type: url-fetch",
        "    transport:",
        "      primary: proxy-legacy",
      ].join("\n"), "utf8");

      const { loadRunnerStartup } = await import("../src/runner/config.js");
      const startup = await loadRunnerStartup(yamlPath, {
        database: openSqlite(":memory:", runnerMigrations),
      });
      try {
        const safe = startup.service.readSafe();
        const legacy = safe.proxies.find((entry) => entry.id === "proxy-legacy");
        expect(legacy).toMatchObject({ type: "http-proxy", hasCredentials: true });
        expect(legacy?.address).toBe("http://proxy.example.com:3128/");
        expect(JSON.stringify(safe)).not.toContain("legacy-secret");
        expect(startup.config.providers["url-fetch"]?.transport).toEqual({
          primary: "proxy-legacy",
          fallback: [],
        });
      } finally {
        startup.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts from the database when legacy YAML contains stale proxy env placeholders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aylens-runner-config-"));
    try {
      const yamlPath = join(dir, "runner.yaml");
      // 首次启动导入 proxy-live。
      await writeFile(yamlPath, [
        "runner:",
        "  id: stale-runner",
        "  gatewayUrl: \"ws://127.0.0.1:3000/v1/runners/connect\"",
        "  token: dev-runner-token",
        "transports:",
        "  proxy-live:",
        "    type: http-proxy",
        "    url: \"http://proxy-live.example.com:3128\"",
      ].join("\n"), "utf8");

      const first = await import("../src/runner/config.js");
      // 两次启动都用同一文件库,验证数据库状态跨进程延续。
      const fileDbPath = join(dir, "state.sqlite");
      const startup1 = await first.loadRunnerStartup(yamlPath, { databasePath: fileDbPath });
      startup1.close();

      // 第二次启动:YAML 改成失效的环境变量占位符与已删除的旧绑定。
      await writeFile(yamlPath, [
        "runner:",
        "  id: stale-runner",
        "  gatewayUrl: \"ws://127.0.0.1:3000/v1/runners/connect\"",
        "  token: dev-runner-token",
        "transports:",
        "  proxy-live:",
        "    type: http-proxy",
        "    url: \"${MISSING_PROXY_URL}\"",
        "providers:",
        "  url-fetch:",
        "    type: url-fetch",
        "    transport:",
        "      primary: proxy-gone",
      ].join("\n"), "utf8");

      const second = await import("../src/runner/config.js");
      const startup2 = await second.loadRunnerStartup(yamlPath, { databasePath: fileDbPath });
      try {
        const safe = startup2.service.readSafe();
        // 数据库里的 proxy-live 仍然可用,YAML 的失效内容没有生效。
        expect(safe.proxies.find((entry) => entry.id === "proxy-live")).toBeDefined();
        expect(startup2.config.providers["url-fetch"]?.transport).toBeUndefined();
      } finally {
        startup2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
