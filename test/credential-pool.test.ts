import { describe, expect, it } from "vitest";
import { CredentialPool } from "../src/runner/credentials/pool.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";

function stateWith(credentials: CredentialRuntimeState["credentials"]): CredentialRuntimeState {
  return {
    version: 1,
    pools: [{ id: "p", service: "tavily", name: "P", enabled: true }],
    credentials,
    bindings: {},
    state: {},
  };
}

const twoHealthy: CredentialRuntimeState["credentials"] = [
  { id: "k1", poolId: "p", name: "1", secret: "s1", enabled: true, accountGroup: "acct", createdAt: 1 },
  { id: "k2", poolId: "p", name: "2", secret: "s2", enabled: true, accountGroup: "acct", createdAt: 2 },
];

describe("CredentialPool rotation", () => {
  it("rotates across healthy credentials", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));

    const first = pool.acquire("p");
    first.release();
    const second = pool.acquire("p");
    second.release();

    expect([first.credentialId, second.credentialId]).toEqual(["k1", "k2"]);
  });

  it("releases occupancy on failure so capacity is not leaked", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));
    const lease = pool.acquire("p");
    lease.reportFailure({ category: "network", scope: "unknown" });
    lease.release();

    expect(pool.tryAcquire("p")).toBeDefined();
  });

  it("is idempotent when release is called twice", () => {
    const pool = new CredentialPool(stateWith([
      { id: "k1", poolId: "p", name: "1", secret: "s1", enabled: true, createdAt: 1 },
    ]), { maxConcurrency: 1 });

    const lease = pool.acquire("p");
    lease.release();
    lease.release();

    // 重复释放不得把占用计数扣成负数：否则并发上限会静默失效。
    const again = pool.acquire("p");
    expect(again.credentialId).toBe("k1");
    expect(pool.tryAcquire("p")).toBeUndefined();
    again.release();
    expect(pool.availability("k1")).toBe("available");
  });

  it("skips credentials that already run at their concurrency limit", () => {
    const pool = new CredentialPool(stateWith(twoHealthy), { maxConcurrency: 1 });
    const first = pool.acquire("p");

    const second = pool.acquire("p");
    expect(second.credentialId).toBe("k2");

    first.release();
    second.release();
  });
});

describe("CredentialPool failure classification", () => {
  it("isolates a credential on auth failure", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));
    const lease = pool.acquire("p");
    lease.reportFailure({ category: "auth", scope: "credential" });
    lease.release();

    expect(pool.availability("k1")).toBe("auth_failed");
    expect(pool.tryAcquire("p")?.credentialId).toBe("k2");
  });

  it("does not rotate siblings when the account is rate limited", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));
    const lease = pool.acquire("p");
    lease.reportFailure({ category: "rate_limited", scope: "account", retryAfterMs: 30_000 });
    lease.release();

    // 同一账号的所有 Key 共享限流：换另一个 Key 也一样被拒。
    expect(pool.tryAcquire("p")).toBeUndefined();
  });

  it("honours Retry-After for credential-scope rate limiting", () => {
    let now = 1_000;
    const pool = new CredentialPool(stateWith(twoHealthy), { now: () => now });
    const lease = pool.acquire("p");
    lease.reportFailure({ category: "rate_limited", scope: "credential", retryAfterMs: 5_000 });
    lease.release();

    expect(pool.availability("k1")).toBe("cooling");
    expect(pool.tryAcquire("p", { now: now + 1_000 })?.credentialId).toBe("k2");

    now += 5_001;
    expect(pool.availability("k1")).toBe("available");
    expect(pool.tryAcquire("p", { now })).toBeDefined();
  });

  it("does not blacklist a credential for account-scope quota exhaustion", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));
    const lease = pool.acquire("p");
    lease.reportFailure({ category: "quota", scope: "account" });
    lease.release();

    expect(pool.availability("k1")).not.toBe("auth_failed");
    expect(pool.tryAcquire("p")).toBeUndefined();
  });

  it("never changes credential state for request-level or item failures", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));

    const requestLease = pool.acquire("p");
    requestLease.reportFailure({ category: "invalid_request", scope: "request" });
    requestLease.release();

    expect(pool.availability("k1")).toBe("available");

    const itemLease = pool.acquire("p");
    itemLease.reportFailure({ category: "item_content", scope: "request" });
    itemLease.release();

    expect(pool.availability("k2")).toBe("available");
    expect(pool.tryAcquire("p")).toBeDefined();
  });
});

describe("CredentialPool stale and disabled states", () => {
  it("ignores stale reports from a replaced credential version", () => {
    const pool = new CredentialPool(stateWith(twoHealthy));
    const lease = pool.acquire("p");

    pool.replaceState({
      ...stateWith(twoHealthy.map((credential) =>
        credential.id === "k1" ? { ...credential, secret: "s1-replaced" } : credential)),
      version: 2,
    });

    lease.reportFailure({ category: "auth", scope: "credential" });
    lease.release();

    expect(pool.availability("k1")).not.toBe("auth_failed");
  });

  it("does not select manually disabled credentials", () => {
    const pool = new CredentialPool(stateWith([
      { id: "k1", poolId: "p", name: "1", secret: "s1", enabled: false, createdAt: 1 },
      { id: "k2", poolId: "p", name: "2", secret: "s2", enabled: true, createdAt: 2 },
    ]));

    expect(pool.availability("k1")).toBe("disabled");
    expect(pool.tryAcquire("p")?.credentialId).toBe("k2");
  });

  it("reports a safe reason when no credential is usable", () => {
    const pool = new CredentialPool(stateWith([
      { id: "k1", poolId: "p", name: "1", secret: "s1", enabled: false, createdAt: 1 },
    ]));

    expect(() => pool.acquire("p")).toThrowError(/no usable credential/i);
    expect(pool.tryAcquire("p")).toBeUndefined();
  });

  it("fails closed when the pool itself is missing or disabled", () => {
    const missing = new CredentialPool(stateWith(twoHealthy));
    expect(() => missing.acquire("nope")).toThrowError(/pool/i);

    const disabled = new CredentialPool({
      ...stateWith(twoHealthy),
      pools: [{ id: "p", service: "tavily", name: "P", enabled: false }],
    });
    expect(disabled.tryAcquire("p")).toBeUndefined();
  });
});
