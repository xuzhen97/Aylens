import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import type { BrowserHost, BrowserSession } from "../src/browser/types.js";
import { RetrievalError } from "../src/core/errors.js";
import type { ProviderFactoryContext, ProviderContext } from "../src/providers/types.js";
import { urlFetchFactory } from "../src/providers/url-fetch/index.js";
import type { HttpTransport, TransportRequest, TransportResponse, TransportResponsePolicy } from "../src/transports/types.js";
import { TransportRegistry } from "../src/transports/registry.js";

const context: ProviderContext = {
  requestId: "req-1",
  traceId: "trace-1",
  runtimeId: "runner-1",
  jobId: "job-1",
};

const target = "https://example.com/page";

// SAFETY: 假对象只实现被测代码实际调用的方法；断言成 Playwright / BrowserHost 类型是为了让被测
// 函数保持真实签名，而不是把生产代码放宽成 any。
function asSession(value: unknown): BrowserSession {
  return value as BrowserSession;
}

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

class FakeTransport implements HttpTransport {
  readonly calls: Array<{ url: string; policy: TransportResponsePolicy | undefined }> = [];

  constructor(
    readonly id: string,
    private readonly handler: (url: string, callIndex: number) => FakeResponse | Error,
  ) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push({ url: request.url, policy: request.responsePolicy });

    const result = this.handler(request.url, this.calls.length);
    if (result instanceof Error) throw result;

    return {
      status: result.status ?? 200,
      headers: new Headers(result.headers ?? {}),
      body: result.body ?? "",
    };
  }
}

function createServices(
  transports: Array<{ id: string; type: "direct" | "http-proxy"; transport: HttpTransport }>,
  browser?: BrowserHost,
): ProviderFactoryContext {
  const registry = new TransportRegistry();

  for (const entry of transports) {
    registry.registerFactory({
      type: entry.type,
      create: () => entry.transport,
    });
    registry.build(
      entry.id,
      entry.type === "direct" ? { type: "direct" } : { type: "http-proxy", url: "http://127.0.0.1:1" },
    );
  }

  return { transports: registry, browser, defaultBrowserProfile: "browser-main" };
}

function createBrowserSpy(page: Page) {
  const state = { calls: 0 };

  const host: BrowserHost = {
    async withProfile<T>(
      profileId: string,
      jobId: string,
      callback: (session: BrowserSession) => Promise<T>,
    ): Promise<T> {
      state.calls += 1;
      const browserContext = {
        newPage: async () => page,
        close: async () => undefined,
      };
      return await callback(asSession({ profileId, context: browserContext }));
    },
    async close(): Promise<void> {},
  };

  return { host, calls: () => state.calls };
}

function createFakePage(html: string, finalUrl = target): Page {
  const page = {
    url: () => finalUrl,
    goto: async () => ({ status: () => 200 }),
    waitForFunction: async () => undefined,
    content: async () => html,
    close: async () => undefined,
  };

  // SAFETY: 同上——仅实现被测代码调用的方法。
  return page as unknown as Page;
}

function createProvider(options: {
  transport: HttpTransport;
  type?: "direct" | "http-proxy";
  transportConfig?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  browser?: BrowserHost;
}) {
  const services = createServices(
    [{ id: options.type === "http-proxy" ? "proxy" : "direct", type: options.type ?? "direct", transport: options.transport }],
    options.browser,
  );

  return urlFetchFactory.create("url-fetch", {
    type: "url-fetch",
    options: options.providerOptions ?? {},
    ...(options.transportConfig
      ? { transport: options.transportConfig as { primary: string; fallback: string[] } }
      : {}),
  }, services);
}

function registryFor(entries: Array<{ id: string; transport: HttpTransport }>): TransportRegistry {
  const registry = new TransportRegistry();
  const byId = new Map(entries.map((entry) => [entry.id, entry.transport]));

  // 工厂按 type 注册一次，再由 create(id) 分派到具体假传输，避免重复注册同一个 type。
  registry.registerFactory({
    type: "direct",
    create: (id) => {
      const transport = byId.get(id);
      if (!transport) throw new Error(`unknown test transport: ${id}`);
      return transport;
    },
  });

  for (const entry of entries) registry.build(entry.id, { type: "direct" });
  return registry;
}

describe("url-fetch provider orchestration", () => {
  it("returns native markdown without touching the browser", async () => {
    const transport = new FakeTransport("direct", () => ({
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: "# Title\n\nBody paragraph.\n",
    }));
    const browser = createBrowserSpy(createFakePage("<html><body>used</body></html>"));
    const provider = createProvider({ transport, browser: browser.host });

    const result = await provider.search(context, { query: target });

    expect(result.items[0]?.markdown).toContain("# Title");
    expect(result.items[0]?.text).toContain("Title");
    expect(browser.calls()).toBe(0);
    expect(result.items[0]?.extensions?.engine).toBe("http");
  });

  it("converts static HTML and resolves the canonical url", async () => {
    const html = '<html><head><title>Doc</title><link rel="canonical" href="/canonical"></head>'
      + "<body><nav><a href=\"/a\">Nav A</a></nav><main><h2>Heading</h2><pre><code>code line</code></pre></main></body></html>";
    const transport = new FakeTransport("direct", () => ({ headers: { "content-type": "text/html" }, body: html }));
    const browser = createBrowserSpy(createFakePage("<html><body>used</body></html>"));
    const provider = createProvider({ transport, browser: browser.host });

    const result = await provider.search(context, { query: target });

    expect(result.items[0]?.markdown).toContain("```");
    expect(result.items[0]?.markdown).not.toContain("Nav A");
    expect(result.items[0]?.canonicalUrl).toBe("https://example.com/canonical");
    expect(browser.calls()).toBe(0);
  });

  it("works on a runtime without any browser", async () => {
    const transport = new FakeTransport("direct", () => ({
      headers: { "content-type": "text/plain" },
      body: "plain body",
    }));
    const provider = createProvider({ transport });

    const result = await provider.search(context, { query: target });

    expect(result.items[0]?.markdown).toContain("plain body");
  });

  it("uses exactly one browser attempt for a JS shell", async () => {
    const transport = new FakeTransport("direct", () => ({
      headers: { "content-type": "text/html" },
      body: '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    }));
    const rendered = "<html><head><title>App</title></head><body><main><p>Rendered content from the application shell.</p></main></body></html>";
    const browser = createBrowserSpy(createFakePage(rendered));
    const provider = createProvider({
      transport,
      browser: browser.host,
      providerOptions: { controlledBrowserEgress: true },
    });

    const result = await provider.search(context, { query: target });

    expect(browser.calls()).toBe(1);
    expect(result.items[0]?.markdown).toContain("Rendered content");
    expect(result.items[0]?.extensions?.engine).toBe("browser");
  });

  it("fails clearly when the page still requires authentication after the browser attempt", async () => {
    const transport = new FakeTransport("direct", () => ({ status: 401, headers: { "content-type": "text/html" }, body: "" }));
    const login = "<html><head><title>Sign in</title></head><body><form><input type=\"password\"><h1>Sign in to continue</h1></form></body></html>";
    const browser = createBrowserSpy(createFakePage(login));
    const provider = createProvider({
      transport,
      browser: browser.host,
      providerOptions: { controlledBrowserEgress: true },
    });

    await expect(provider.search(context, { query: target })).rejects.toMatchObject({
      code: "UPSTREAM_AUTH_FAILED",
    });
    expect(browser.calls()).toBe(1);
  });

  it("does not start the browser when fallback is disabled", async () => {
    const transport = new FakeTransport("direct", () => ({
      headers: { "content-type": "text/html" },
      body: '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    }));
    const browser = createBrowserSpy(createFakePage("<html><body>used</body></html>"));
    const provider = createProvider({
      transport,
      browser: browser.host,
      providerOptions: { browserFallback: false },
    });

    await expect(provider.search(context, { query: target })).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    expect(browser.calls()).toBe(0);
  });

  it("never starts the browser for deterministic failures", async () => {
    const browser = createBrowserSpy(createFakePage("<html><body>used</body></html>"));

    const cases: Array<{ response: FakeResponse; code: string }> = [
      { response: { status: 404 }, code: "CONTENT_UNAVAILABLE" },
      { response: { status: 429 }, code: "RATE_LIMITED" },
      { response: { status: 500 }, code: "UPSTREAM_ERROR" },
      { response: { status: 200, headers: { "content-type": "application/pdf" }, body: "pdf" }, code: "CONTENT_UNAVAILABLE" },
    ];

    for (const testCase of cases) {
      const transport = new FakeTransport("direct", () => testCase.response);
      const provider = createProvider({ transport, browser: browser.host });
      await expect(provider.search(context, { query: target })).rejects.toMatchObject({ code: testCase.code });
    }

    expect(browser.calls()).toBe(0);
  });

  it("rejects a forbidden target before any request", async () => {
    const transport = new FakeTransport("direct", () => ({ body: "unused" }));
    const provider = createProvider({ transport });

    await expect(provider.search(context, { query: "file:///etc/passwd" })).rejects.toMatchObject({
      code: "URL_FORBIDDEN",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses an unconfirmed proxy transport", async () => {
    const transport = new FakeTransport("proxy", () => ({ body: "unused" }));
    const provider = createProvider({
      transport,
      type: "http-proxy",
      transportConfig: { primary: "proxy" },
    });

    await expect(provider.search(context, { query: target })).rejects.toMatchObject({
      code: "NETWORK_POLICY_REJECTED",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("does not upgrade an HTTP timeout to the browser unless it is configured", async () => {
    const transport = new FakeTransport("direct", () => new RetrievalError("TIMEOUT", "http timed out", { retryable: true }));
    const browser = createBrowserSpy(createFakePage("<html><body>used</body></html>"));
    const provider = createProvider({
      transport,
      browser: browser.host,
      providerOptions: { controlledBrowserEgress: true },
    });

    await expect(provider.search(context, { query: target })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(browser.calls()).toBe(0);
  });

  it("falls back to the next transport only for retryable network failures", async () => {
    const failing = new FakeTransport("direct", () => new RetrievalError("NETWORK_ERROR", "network down", { retryable: true }));
    const healthy = new FakeTransport("backup", () => ({
      headers: { "content-type": "text/plain" },
      body: "from backup transport",
    }));

    const registry = registryFor([
      { id: "direct", transport: failing },
      { id: "backup", transport: healthy },
    ]);

    const provider = urlFetchFactory.create("url-fetch", {
      type: "url-fetch",
      options: {},
      transport: { primary: "direct", fallback: ["backup"] },
    }, { transports: registry, defaultBrowserProfile: "browser-main" });

    const result = await provider.search(context, { query: target });

    expect(result.items[0]?.markdown).toContain("from backup transport");
    expect(failing.calls).toHaveLength(1);
    expect(healthy.calls).toHaveLength(1);
  });

  it("does not retry a deterministic resource rejection on another transport", async () => {
    const limited = new FakeTransport("direct", () => new RetrievalError("CONTENT_UNAVAILABLE", "too large"));
    const backup = new FakeTransport("backup", () => ({ body: "unused" }));

    const registry = registryFor([
      { id: "direct", transport: limited },
      { id: "backup", transport: backup },
    ]);

    const provider = urlFetchFactory.create("url-fetch", {
      type: "url-fetch",
      options: {},
      transport: { primary: "direct", fallback: ["backup"] },
    }, { transports: registry, defaultBrowserProfile: "browser-main" });

    await expect(provider.search(context, { query: target })).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    expect(backup.calls).toHaveLength(0);
  });

  it("reports a structured error for an unknown option instead of silently ignoring it", () => {
    expect(() => createProvider({
      transport: new FakeTransport("direct", () => ({ body: "x" })),
      providerOptions: { maxResponseByte: 10 },
    })).toThrowError(RetrievalError);
  });

  it("returns the readable static content when a short page trips the shell heuristic", async () => {
    // 正文很短但确实可读，只是恰好带了个 script（例如统计脚本）——不能因此让整个请求失败。
    const html = '<html><head><title>Status</title></head><body>'
      + '<main><p>The service is operating normally and all checks have passed.</p></main>'
      + '<script src="/analytics.js"></script></body></html>';
    const transport = new FakeTransport("direct", () => ({ headers: { "content-type": "text/html" }, body: html }));
    const browser = createBrowserSpy(createFakePage("<html><body>used</body></html>"));
    // 刻意不设 controlledBrowserEgress：模拟出厂默认配置下兜底跑不起来。
    const provider = createProvider({ transport, browser: browser.host });

    const result = await provider.search(context, { query: target });

    expect(result.items[0]?.markdown).toContain("operating normally");
    expect(result.items[0]?.extensions?.engine).toBe("http");
    expect(result.items[0]?.extensions?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("NETWORK_POLICY_REJECTED")]),
    );
    expect(browser.calls()).toBe(0);
  });

  it("still fails for a login page when the browser fallback cannot run", async () => {
    const transport = new FakeTransport("direct", () => ({ status: 401, headers: { "content-type": "text/html" }, body: "" }));
    const login = '<html><head><title>Sign in</title></head><body><form><input type="password"><h1>Sign in to continue</h1></form></body></html>';
    const browser = createBrowserSpy(createFakePage(login));
    const provider = createProvider({ transport, browser: browser.host });

    // 把登录页当正文“成功”返回才是真正的错误；这里必须明确失败。
    await expect(provider.search(context, { query: target })).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
    expect(browser.calls()).toBe(0);
  });
});
