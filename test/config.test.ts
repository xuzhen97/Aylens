import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";
import { interpolateEnv } from "../src/config/loader.js";
import { runnerConfigSchema } from "../src/runner/config.js";

describe("config", () => {
  it("interpolates environment values and fallbacks", () => {
    expect(interpolateEnv("a=${A} b=${B:-fallback}", { A: "value" })).toBe("a=value b=fallback");
  });

  it("does not require variables referenced from comments", () => {
    const input = [
      "runner:",
      "  id: dev-runner",
      "",
      "  # proxy-us:",
      '  #   type: http-proxy',
      '  #   url: "${PROXY_US_URL}"',
      "  #   token: ${PROXY_TOKEN}",
      "",
      '  gatewayUrl: "ws://${HOST:-127.0.0.1}:3000"',
      "",
    ].join("\n");

    const result = interpolateEnv(input, {});

    expect(result).toContain('url: "${PROXY_US_URL}"');
    expect(result).toContain("token: ${PROXY_TOKEN}");
    expect(result).toContain('gatewayUrl: "ws://127.0.0.1:3000"');
  });

  it("still interpolates live values that contain a hash", () => {
    expect(
      interpolateEnv('  apiKey: "${KEY}" # dev only', { KEY: "a#b" }),
    ).toBe('  apiKey: "a#b" # dev only');
  });

  it("throws when a live value references a missing variable", () => {
    expect(() => interpolateEnv('token: "${MISSING_TOKEN}"', {})).toThrow(
      "Missing environment variable: MISSING_TOKEN",
    );
  });

  it("applies Gateway section defaults when server and runtimeRegistry are omitted", () => {
    const parsed = appConfigSchema.parse({
      version: 1,
      auth: { apiKey: "a" },
    });

    expect(parsed.server).toEqual({
      host: "127.0.0.1",
      port: 3000,
      runnerPath: "/v1/runners/connect",
    });
    expect(parsed.runtimeRegistry).toEqual({
      heartbeatTimeoutMs: 30_000,
      offlineAfterMs: 60_000,
      jobTimeoutMs: 30_000,
    });
  });

  it("supports a shared Runner default browser profile and rejects an unknown default", () => {
    const valid = runnerConfigSchema.safeParse({
      runner: {
        id: "runner-1",
        gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect",
        token: "token",
      },
      browser: { defaultProfile: "browser-main" },
      browserProfiles: {
        "browser-main": { userDataDir: "./.profiles/browser-main" },
      },
    });

    const invalid = runnerConfigSchema.safeParse({
      runner: {
        id: "runner-1",
        gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect",
        token: "token",
      },
      browser: { defaultProfile: "missing" },
      browserProfiles: {},
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it("rejects routes that reference unknown providers", () => {
    const result = appConfigSchema.safeParse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/runner" },
      auth: { apiKey: "a", runnerTokens: {} },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 2000, jobTimeoutMs: 1000 },
      providers: {},
      routes: { default: { providers: ["missing"] } },
    });

    expect(result.success).toBe(false);
  });

  it("allows provider placement to be omitted while rejecting legacy local mode", () => {
    const baseConfig = {
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/runner" },
      auth: { apiKey: "a", runnerTokens: {} },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 2000, jobTimeoutMs: 1000 },
      routes: { default: { providers: [] } },
    };

    const missing = appConfigSchema.safeParse({
      ...baseConfig,
      providers: { p: { type: "t" } },
    });
    const legacyLocalMode = appConfigSchema.safeParse({
      ...baseConfig,
      providers: { p: { type: "t", runtime: { mode: "local" } } },
    });
    const runner = appConfigSchema.safeParse({
      ...baseConfig,
      providers: { p: { type: "t", runtime: { nodeId: "runner-1" } } },
    });

    expect(missing.success).toBe(true);
    expect(legacyLocalMode.success).toBe(false);
    expect(runner.success).toBe(true);
  });

  it("keeps Gateway config on the control plane only", () => {
    const parsed = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/runner" },
      auth: { apiKey: "a", runnerTokens: {} },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 2000, jobTimeoutMs: 1000 },
      transports: { direct: { type: "direct" } },
      providers: {},
      routes: { default: { providers: [] } },
      browserProfiles: {},
    });

    expect("transports" in parsed).toBe(false);
    expect("browserProfiles" in parsed).toBe(false);
  });
});
