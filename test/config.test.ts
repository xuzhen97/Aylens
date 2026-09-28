import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { appConfigSchema } from "../src/config/schema.js";
import { interpolateEnv, loadConfig } from "../src/config/loader.js";
import { loadRunnerConfig } from "../src/runner/config.js";

const repoPath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

describe("config", () => {
  it("interpolates environment values and fallbacks", () => {
    expect(interpolateEnv("a=${A} b=${B:-fallback}", { A: "value" })).toBe("a=value b=fallback");
  });

  it("ignores env placeholders only inside real YAML comments", () => {
    const input = [
      "url: ${REAL:-default}",
      "# url: ${COMMENTED_OUT}",
      "  # ind: ${ALSO_COMMENTED}",
      "quoted: \"literal # ${QUOTED:-quoted-value}\"",
      "block: |",
      "  literal # ${BLOCK:-block-value}",
    ].join("\n");

    expect(interpolateEnv(input, {})).toBe([
      "url: default",
      "# url: ${COMMENTED_OUT}",
      "  # ind: ${ALSO_COMMENTED}",
      "quoted: \"literal # quoted-value\"",
      "block: |",
      "  literal # block-value",
    ].join("\n"));
  });

  // Regression: the shipped defaults are what `npm run dev` / `npm run dev:runner`
  // load. They used to be empty stubs, so the admin UI showed a runner with an
  // empty capability list and a gateway with no providers.
  it("wires generic-browser in the default runner config", async () => {
    const config = await loadRunnerConfig(repoPath("../config/runner.yaml"));
    expect(config.plugins.modules).toContain("./plugins/generic-browser/index.mjs");
    expect(config.capabilities.browserAutomation).toBe(true);
    expect(Object.keys(config.browserProfiles)).toContain("generic-login");
  });

  it("wires generic-browser in the default gateway config", async () => {
    const config = await loadConfig(repoPath("../config/aylens.yaml"));
    expect(config.providers["generic-browser"]?.enabled).toBe(true);
    expect(config.providers["generic-browser"]?.options.keepPageOpen).toBe(false);
    expect(config.routes.default?.providers).toContain("generic-browser");
    // The default runner id must be trusted, or the runner is rejected on connect.
    expect(Object.keys(config.auth.runnerTokens)).toEqual(
      expect.arrayContaining(["windows-generic-01"]),
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
