import type { BrowserContext } from "playwright-core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import type { BrowserHost } from "../src/browser/types.js";
import { BrowserProfileManager } from "../src/browser/profile-manager.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { loadProviderPlugins } from "../src/providers/plugin.js";
import { AylensRunner } from "../src/runner/runner.js";
import { runnerConfigSchema } from "../src/runner/config.js";
import type { RunnerRuntime } from "../src/runner/runtime.js";
import { TransportRegistry } from "../src/transports/registry.js";

let app: FastifyInstance | undefined;
let runner: AylensRunner | undefined;

afterEach(async () => {
  if (runner) await runner.close();
  runner = undefined;

  if (app) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.close();
    app = undefined;
  }
});

describe("generic-browser Gateway/Runner flow", () => {
  it("returns browser-extracted content through the real Runner protocol", async () => {
    const gatewayConfig = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
      auth: { apiKey: "api", runnerTokens: { "browser-runner": "runner-token" } },
      runtimeRegistry: {
        heartbeatTimeoutMs: 1000,
        offlineAfterMs: 5000,
        jobTimeoutMs: 2000,
      },
      transports: { direct: { type: "direct" } },
      providers: {
        browserRead: {
          type: "generic-browser",
          enabled: true,
          runtime: {
            selector: {
              providerType: "generic-browser",
              browser: "chrome",
              profile: "browser-main",
            },
          },
        },
      },
      routes: { default: { providers: ["browserRead"] } },
      browserProfiles: {},
    });

    const gateway = createGatewayContext(gatewayConfig);
    app = buildHttpServer(gateway);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const websocketUrl = new URL(address);
    websocketUrl.protocol = "ws:";
    websocketUrl.pathname = gatewayConfig.server.runnerPath;

    const runnerConfig = runnerConfigSchema.parse({
      runner: {
        id: "browser-runner",
        gatewayUrl: websocketUrl.toString(),
        token: "runner-token",
        heartbeatMs: 50,
        maxJobs: 1,
        labels: { role: "browser" },
      },
      plugins: { baseDir: ".", modules: [] },
      providers: {
        browserRead: {
          type: "generic-browser",
          browser: { profile: "browser-main" },
          options: {},
        },
      },
      transports: { direct: { type: "direct" } },
      browserProfiles: {
        "browser-main": {
          browser: "chrome",
          mode: "launch",
          persistent: true,
          userDataDir: "D:/profiles/browser-main",
          maxConcurrency: 1,
          interactive: true,
          headless: false,
          channel: "chrome",
          args: [],
        },
      },
    });

    const loaded = await loadProviderPlugins(
      ["builtin:generic-browser"],
      process.cwd(),
    );
    const providers = new ProviderRegistry();
    for (const factory of loaded.factories) providers.registerFactory(factory);

    const profiles = new BrowserProfileManager();
    profiles.register({
      id: "browser-main",
      browser: "chrome",
      mode: "launch",
      persistent: true,
      userDataDir: "D:/profiles/browser-main",
      maxConcurrency: 1,
      interactive: true,
      headless: false,
      channel: "chrome",
      args: [],
    });

    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      waitForTimeout: vi.fn(async () => undefined),
      title: vi.fn(async () => "Authenticated Area"),
      url: vi.fn(() => "https://example.com/account"),
      locator: vi.fn(() => ({
        first: () => ({
          innerText: async () => "Signed in as demo-user",
        }),
      })),
      close: vi.fn(async () => undefined),
    };

    const browser: BrowserHost = {
      withProfile: async (profileId, jobId, callback) => {
        expect(profileId).toBe("browser-main");
        expect(jobId).toMatch(/^job_/);
        return callback({
          profileId,
          context: {
            newPage: async () => page,
          } as unknown as BrowserContext,
        });
      },
      close: async () => undefined,
    };

    const runtime: RunnerRuntime = {
      providers,
      deployments: runnerConfig.providers,
      transports: new TransportRegistry(),
      profiles,
      browser,
      pluginTypes: providers.factoryTypes(),
      providerAuthStates: new Map(),
      reportProviderAuthState: () => undefined,
      close: async () => browser.close(),
    };

    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    const response = await gateway.search.search({
      query: "https://example.com/account",
    });

    expect(response.status).toBe("completed");
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      platform: "web",
      type: "webpage",
      url: "https://example.com/account",
      title: "Authenticated Area",
      text: "Signed in as demo-user",
    });
    expect(response.items[0]?.provenance).toMatchObject({
      provider: "browserRead",
      retrievalMethod: "browser",
      runtimeId: "browser-runner",
    });
    expect(response.meta.providers.browserRead?.runtimeId).toBe("browser-runner");

    const immediateFollowUp = await gateway.search.search({
      query: "https://example.com/account?second=1",
    });

    expect(immediateFollowUp.status).toBe("completed");
    expect(immediateFollowUp.items).toHaveLength(1);
    expect(page.goto).toHaveBeenCalledTimes(2);
  });
});
