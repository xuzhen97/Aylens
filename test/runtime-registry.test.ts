import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "../src/runtime/registry.js";
import { LOCAL_RUNTIME_ID } from "../src/runtime/types.js";
import type { RuntimeRecord } from "../src/runtime/types.js";

function runtime(id: string, activeJobs: number, profiles: string[]): RuntimeRecord {
  return {
    id,
    hostname: id,
    os: "windows",
    version: "1",
    protocolVersion: "1",
    status: "online",
    labels: { role: "browser" },
    capabilities: {
      providerTypes: ["browser-provider"],
      browsers: ["chrome"],
      profiles,
      http: true,
      browserAutomation: true,
    },
    capacity: { maxJobs: 4, activeJobs },
    lastSeenAt: Date.now(),
  };
}

/**
 * The Gateway's own registry entry: online, but with no provider types, no
 * browsers, and a capacity far larger than any Runner. Its `lastSeenAt` is only
 * ever written once, at startup.
 */
function localRuntime(): RuntimeRecord {
  return {
    id: LOCAL_RUNTIME_ID,
    hostname: "gateway",
    os: "windows",
    version: "1",
    protocolVersion: "local",
    status: "online",
    labels: { role: "gateway" },
    capabilities: { providerTypes: [], browsers: [], profiles: [], http: true, browserAutomation: false },
    capacity: { maxJobs: 64, activeJobs: 0 },
    lastSeenAt: Date.now(),
  };
}

describe("RuntimeRegistry", () => {
  it("selects a compatible runtime with lower load", () => {
    const registry = new RuntimeRegistry(60_000);
    registry.upsert(runtime("busy", 3, ["xhs-main"]));
    registry.upsert(runtime("idle", 0, ["xhs-main"]));

    const selected = registry.select({
      os: "windows",
      providerType: "browser-provider",
      browser: "chrome",
      profile: "xhs-main",
      labels: { role: "browser" },
    });

    expect(selected.id).toBe("idle");
  });

  it("never places work on the gateway's own record", () => {
    const registry = new RuntimeRegistry(60_000);
    registry.upsert(localRuntime());
    registry.upsert(runtime("windows-node", 0, ["xhs-main"]));

    // `os` alone also matches the gateway's record, and an equal load ratio
    // would otherwise let it win on insertion order.
    expect(registry.select({ os: "windows" }).id).toBe("windows-node");
  });

  it("reports no compatible runtime rather than falling back to the gateway", () => {
    const registry = new RuntimeRegistry(60_000);
    registry.upsert(localRuntime());

    expect(() => registry.select({ os: "windows" })).toThrowError(/No compatible runtime/);
    expect(() => registry.select({ labels: { role: "gateway" } })).toThrowError(/No compatible runtime/);
  });

  it("still lists the gateway's own record for status reporting", () => {
    const registry = new RuntimeRegistry(60_000);
    registry.upsert(localRuntime());

    expect(registry.list().map((entry) => entry.id)).toEqual([LOCAL_RUNTIME_ID]);
    expect(registry.get(LOCAL_RUNTIME_ID)?.status).toBe("online");
  });
});
