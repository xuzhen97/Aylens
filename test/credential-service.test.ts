import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { CredentialConfigService } from "../src/runner/credentials/service.js";
import { CredentialStore } from "../src/runner/credentials/store.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";

let db: DatabaseSync;
let service: CredentialConfigService;

function pool(id: string, service_: string = "tavily") {
  return { kind: "put-pool", id, service: service_, name: id, enabled: true } as const;
}

beforeEach(() => {
  db = openSqlite(":memory:", runnerMigrations);
  // 显式给出 Provider type 映射：否则 bind 会命中“未知部署”分支，
  // 让“服务不匹配”的用例以错误的理由通过。
  service = new CredentialConfigService(new CredentialStore(db), {
    tavily: "tavily",
    exa: "exa",
  });
  service.write({ operationId: "op-1", expectedVersion: 0, mutation: pool("tavily-main") });
});

afterEach(() => {
  db.close();
});

describe("CredentialConfigService", () => {
  it("creates credentials and bumps the version", () => {
    const view = service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "primary",
        secret: "tvly-aaaa1111",
        enabled: true,
      },
    });

    expect(view.version).toBe(2);
    expect(view.lastOperationId).toBe("op-2");
    expect(view.credentials).toHaveLength(1);
    expect(view.credentials[0]?.maskedSecret).not.toContain("aaaa1111");
    expect(view.pools[0]?.credentialCount).toBe(1);
  });

  it("rejects a stale expectedVersion", () => {
    expect(() => service.write({
      operationId: "op-x",
      expectedVersion: 0,
      mutation: pool("tavily-main"),
    })).toThrowError(/version/i);
  });

  it("keeps the state unchanged after a rejected write", () => {
    const before = service.safeView();
    expect(() => service.write({
      operationId: "op-x",
      expectedVersion: 99,
      mutation: pool("tavily-main"),
    })).toThrowError(/version/i);
    expect(service.safeView()).toEqual(before);
  });

  it("rejects the same secret registered twice as independent capacity", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "a",
        secret: "tvly-duplicate",
        enabled: true,
      },
    });

    expect(() => service.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: {
        kind: "put-credential",
        id: "key-2",
        poolId: "tavily-main",
        name: "b",
        secret: "tvly-duplicate",
        enabled: true,
      },
    })).toThrowError(/duplicate/i);
  });

  it("allows re-saving the same credential with its own secret", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "a",
        secret: "tvly-own-value",
        enabled: true,
      },
    });

    const view = service.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "renamed",
        secret: "tvly-own-value",
        enabled: true,
      },
    });

    expect(view.credentials).toHaveLength(1);
    expect(view.credentials[0]?.name).toBe("renamed");
  });

  it("keeps the stored secret when a mutation omits it", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "a",
        secret: "tvly-keep-me",
        enabled: true,
      },
    });

    service.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "renamed",
        enabled: true,
      },
    });

    expect(service.readState().credentials[0]?.secret).toBe("tvly-keep-me");
  });

  it("lists every deployed provider, including unbound ones", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" },
    });
    service.write({ operationId: "op-3", expectedVersion: 2, mutation: pool("exa-main", "exa") });
    const view = service.safeView();

    // 未绑定的 Provider 也必须出现（poolId: null），否则管理界面无法发起绑定。
    // service 用于界面只展示匹配的池。
    expect(view.providers).toEqual([
      { id: "tavily", poolId: "tavily-main", service: "tavily" },
      { id: "exa", poolId: null, service: "exa" },
    ]);
  });

  it("lists every deployed provider before any binding exists", () => {
    expect(service.safeView().providers).toEqual([
      { id: "tavily", poolId: null, service: "tavily" },
      { id: "exa", poolId: null, service: "exa" },
    ]);
  });

  it("refuses to delete a pool that is still bound", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" },
    });

    expect(() => service.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: { kind: "delete-pool", id: "tavily-main" },
    })).toThrowError(/bound|in use/i);
  });

  it("refuses to delete a pool that still holds credentials", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "a",
        secret: "tvly-still-here",
        enabled: true,
      },
    });

    expect(() => service.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: { kind: "delete-pool", id: "tavily-main" },
    })).toThrowError(/in use|credential/i);
  });

  it("rejects binding a provider to a pool from another service", () => {
    service.write({ operationId: "op-2", expectedVersion: 1, mutation: pool("exa-main", "exa") });

    expect(() => service.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: { kind: "bind", providerId: "tavily", poolId: "exa-main" },
    })).toThrowError(/service/);
  });

  it("accepts binding a provider to a pool of the same service", () => {
    const view = service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" },
    });

    expect(view.providers).toEqual([
      { id: "tavily", poolId: "tavily-main", service: "tavily" },
      { id: "exa", poolId: null, service: "exa" },
    ]);
    expect(view.pools[0]?.providerRefs).toEqual(["tavily"]);
  });

  it("switches the active snapshot only after a successful write", () => {
    const before = service.snapshot();
    expect(() => service.write({
      operationId: "op-bad",
      expectedVersion: 99,
      mutation: { kind: "delete-pool", id: "nope" },
    })).toThrow();
    expect(service.snapshot()).toBe(before);

    const after = service.write({
      operationId: "op-ok",
      expectedVersion: 1,
      mutation: pool("tavily-main"),
    });
    expect(after.version).toBe(2);
    expect(service.snapshot()).not.toBe(before);
    expect(service.snapshot().version).toBe(2);
  });

  it("reports an unknown credential as an invalid mutation", () => {
    expect(() => service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: { kind: "delete-credential", id: "ghost" },
    })).toThrowError(/unknown|credential/i);
  });

  it("never exposes the raw secret through safeView", () => {
    service.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "a",
        secret: "tvly-never-in-response",
        enabled: true,
      },
    });

    expect(JSON.stringify(service.safeView())).not.toContain("tvly-never-in-response");
  });
});
