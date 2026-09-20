import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";
import { interpolateEnv } from "../src/config/loader.js";

describe("config", () => {
  it("interpolates environment values and fallbacks", () => {
    expect(interpolateEnv("a=${A} b=${B:-fallback}", { A: "value" })).toBe("a=value b=fallback");
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
