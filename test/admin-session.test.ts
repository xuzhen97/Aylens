import { describe, expect, it } from "vitest";
import { AdminSessionStore, LoginLimiter } from "../src/api/http/admin-session.js";

describe("AdminSessionStore", () => {
  it("expires absolutely and invalidates sessions when the configured key changes", () => {
    let now = 1_000;
    let apiKey = "original";
    const store = new AdminSessionStore({ getApiKey: () => apiKey, now: () => now });
    const first = store.create();

    expect(first.expiresAt).toBe(1_000 + 2 * 60 * 60 * 1_000);
    now += 1_000;
    expect(store.get(first.id)?.expiresAt).toBe(first.expiresAt);
    apiKey = "changed";
    expect(store.get(first.id)).toBeUndefined();

    const second = store.create();
    now = second.expiresAt;
    expect(store.get(second.id)).toBeUndefined();
  });

  it("rotates, revokes, and bounds sessions without storing the API key or raw session IDs", () => {
    let now = 0;
    const store = new AdminSessionStore({ getApiKey: () => "sensitive-key", now: () => now, maxSessions: 2 });
    const first = store.create();
    const rotated = store.create(first.id);
    expect(store.get(first.id)).toBeUndefined();
    expect(rotated.id).not.toBe(first.id);

    store.create();
    expect(() => store.create()).toThrow(/capacity/i);
    now = rotated.expiresAt;
    expect(store.create().id).toBeTruthy();
    store.revoke(rotated.id);
    store.clear();
    expect(store.get(rotated.id)).toBeUndefined();
    expect(JSON.stringify(store)).not.toContain("sensitive-key");
  });
});

describe("LoginLimiter", () => {
  it("allows ten attempts per window and reports the reset delay", () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.consume("127.0.0.1").allowed).toBe(true);
    }
    expect(limiter.consume("127.0.0.1")).toMatchObject({ allowed: false, retryAfterSeconds: 300 });
    expect(limiter.consume("127.0.0.2").allowed).toBe(true);
    now = 300_000;
    expect(limiter.consume("127.0.0.1").allowed).toBe(true);
  });
});
