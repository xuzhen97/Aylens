import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";
import { interpolateEnv } from "../src/config/loader.js";

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

  it("rejects routes that reference unknown providers", () => {
    const result = appConfigSchema.safeParse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/runner" },
      auth: { apiKey: "a", runnerTokens: {} },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 2000, jobTimeoutMs: 1000 },
      transports: { direct: { type: "direct" } },
      providers: {},
      routes: { default: { providers: ["missing"] } },
      browserProfiles: {},
    });

    expect(result.success).toBe(false);
  });
});
