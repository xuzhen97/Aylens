import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import type { BrowserHost } from "../src/browser/types.js";
import { BrowserProfileManager } from "../src/browser/profile-manager.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { loadProviderPlugins } from "../src/providers/plugin.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
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

const ARTICLE_HTML = [
  "<!doctype html><html><head><title>Aylens Article</title></head><body>",
  '<nav><a href="/other">Navigation noise</a></nav>',
  "<main><h1>Retrieval pipeline</h1>",
  "<p>The runner retrieves the page, extracts the article body and converts it to markdown.</p>",
  "<pre><code>curl -X POST /v1/search</code></pre>",
  "</main></body></html>",
].join("");

/** 静态路径的假传输：不触碰真实网络，也不受公网策略限制（策略由真实传输在连接点执行）。 */
class StaticTransport implements HttpTransport {
  readonly id = "direct";
  readonly calls: string[] = [];

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request.url);

    return {
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      body: ARTICLE_HTML,
      finalUrl: request.url,
    };
  }
}

describe("url-fetch Gateway/Runner flow", () => {
  it("returns extracted markdown through the real Runner protocol without a browser", async () => {
    const gatewayConfig = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
      auth: { apiKey: "api", runnerTokens: { "fetch-runner": "runner-token" } },
      runtimeRegistry: {
        heartbeatTimeoutMs: 1000,
        offlineAfterMs: 5000,
        jobTimeoutMs: 2000,
      },
      transports: { direct: { type: "direct" } },
      providers: {
        reader: {
          type: "url-fetch",
          enabled: true,
          runtime: { selector: { providerType: "url-fetch" } },
        },
      },
      routes: { default: { providers: ["reader"] } },
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
        id: "fetch-runner",
        gatewayUrl: websocketUrl.toString(),
        token: "runner-token",
        heartbeatMs: 50,
        maxJobs: 1,
        labels: { role: "fetch" },
      },
      plugins: { baseDir: ".", modules: [] },
      providers: {
        reader: {
          type: "url-fetch",
          options: {},
        },
      },
      transports: { direct: { type: "direct" } },
      browserProfiles: {},
    });

    const loaded = await loadProviderPlugins(["builtin:url-fetch"], process.cwd());
    const providers = new ProviderRegistry();
    for (const factory of loaded.factories) providers.registerFactory(factory);

    const transport = new StaticTransport();
    const transports = new TransportRegistry();
    transports.registerFactory({ type: "direct", create: () => transport });
    transports.build("direct", { type: "direct" });

    const profiles = new BrowserProfileManager();
    const withProfile = vi.fn();
    const browser: BrowserHost = {
      withProfile,
      close: async () => undefined,
    };

    const runtime: RunnerRuntime = {
      providers,
      deployments: runnerConfig.providers,
      transports,
      profiles,
      browser,
      pluginTypes: providers.factoryTypes(),
      providerAuthStates: new Map(),
      proxyConfig: undefined,
      // 必填字段显式传 undefined：不传会是编译错误，避免装配时静默漏掉。
      credentials: undefined,
      credentialPool: (providerId: string) => {
        throw new Error(`credential pool is not available in this test: ${providerId}`);
      },
      captureExecution: () => ({
        version: 0,
        deployments: runnerConfig.providers,
        transports,
        browser,
      }),
      reportProviderAuthState: () => undefined,
      close: async () => browser.close(),
    };

    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    const response = await gateway.search.search({ query: "https://example.com/article" });

    expect(response.status).toBe("completed");
    expect(response.items).toHaveLength(1);

    const item = response.items[0];
    expect(item).toMatchObject({
      platform: "web",
      type: "webpage",
      url: "https://example.com/article",
      title: "Aylens Article",
    });

    // markdown 必须穿过 Gateway 的响应校验存活下来，text 同时保持纯文本语义。
    expect(item?.markdown).toContain("# Retrieval pipeline");
    expect(item?.markdown ?? "").toContain("```");
    expect(item?.text ?? "").toContain("Retrieval pipeline");
    expect(item?.text ?? "").not.toContain("```");
    expect(item?.markdown ?? "").not.toContain("Navigation noise");

    expect(item?.provenance).toMatchObject({
      provider: "reader",
      retrievalMethod: "http",
      runtimeId: "fetch-runner",
    });
    expect(response.meta.providers.reader?.runtimeId).toBe("fetch-runner");

    // 静态路径不得启动浏览器。
    expect(withProfile).not.toHaveBeenCalled();
    expect(transport.calls).toEqual(["https://example.com/article"]);
  });
});
