import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "../src/runtime/registry.js";
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
      providerIds: ["browser-main"],
      browsers: ["chrome"],
      profiles,
      http: true,
      browserAutomation: true,
    },
    capacity: { maxJobs: 4, activeJobs },
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
    }, "browser-main");

    expect(selected.id).toBe("idle");
  });

  it("reports no compatible runtime instead of falling back to anything", () => {
    const registry = new RuntimeRegistry(60_000);
    registry.upsert(runtime("windows-node", 0, ["xhs-main"]));

    expect(() => registry.select({ providerType: "missing" })).toThrowError(/No compatible runtime/);
    expect(() => registry.select({ profile: "missing" })).toThrowError(/No compatible runtime/);
    expect(() => registry.select({ providerType: "browser-provider" }, "missing-provider")).toThrowError(/No compatible runtime/);

    const full = new RuntimeRegistry(60_000);
    full.upsert(runtime("saturated", 4, ["xhs-main"]));
    expect(() => full.select({ providerType: "browser-provider" })).toThrowError(/No compatible runtime/);
  });
});
