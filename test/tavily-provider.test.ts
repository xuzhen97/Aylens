import { describe, expect, it } from "vitest";
import { CredentialPool } from "../src/runner/credentials/pool.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import type { ProviderContext, ProviderFactoryContext } from "../src/providers/types.js";
import type { ExtractRequest, ExtractItem } from "../src/contracts/extract.js";
import { classifyTavilyFailure } from "../src/providers/tavily/errors.js";
import tavilyPlugin from "../src/providers/tavily/index.js";

const ctx: ProviderContext = { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1", jobId: "job-1" };

const poolState: CredentialRuntimeState = {
  version: 1,
  pools: [{ id: "tavily-main", service: "tavily", name: "Tavily", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "tavily-main", name: "primary", secret: "tvly-first-secret", enabled: true, createdAt: 1 },
    { id: "key-2", poolId: "tavily-main", name: "backup", secret: "tvly-second-secret", enabled: true, createdAt: 2 },
  ],
  bindings: { tavily: "tavily-main" },
  state: {},
};

interface RecordedCall {
  url: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

/** 记录每次上游调用，并按 URL 段返回预设响应。 */
function harness(
  respond: (path: string) => { status: number; headers?: Record<string, string>; body: string },
  state: CredentialRuntimeState = poolState,
) {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = {
    id: "direct",
    request: async ({ url, headers, body }: TransportRequest): Promise<TransportResponse> => {
      calls.push({ url, headers, body });
      const path = new URL(url).pathname;
      const result = respond(path);
      return { status: result.status, headers: new Headers(result.headers ?? {}), body: result.body };
    },
  };

  const transports = new TransportRegistry();
  transports.register(transport);
  const pool = new CredentialPool(state);
  const context: ProviderFactoryContext = {
    transports,
    credentials: { poolForProvider: () => ({ poolId: "tavily-main", pool }) },
  };

  const provider = tavilyPlugin.factories[0]!.create(
    "tavily",
    { type: "tavily", transport: { primary: "direct", fallback: [] }, options: {} },
    context,
  );

  return { provider, calls };
}

const searchBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  request_id: "tvly-req-1",
  response_time: 1.2,
  results: [
    {
      url: "https://a.example/page",
      title: "A page",
      content: "Snippet of the page.",
      score: 0.91,
      raw_content: "# A page\n\nBody text.",
      published_date: "2026-01-02T00:00:00Z",
    },
  ],
  usage: { credits: 1 },
  ...overrides,
});

describe("Tavily search", () => {
  it("maps results into SearchDocument with structured provenance", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    const { items } = await provider.search(ctx, { query: "hello", content: { mode: "full", format: "markdown" } });

    expect(items).toHaveLength(1);
    const document = items[0]!;
    expect(document).toMatchObject({
      url: "https://a.example/page",
      title: "A page",
      // 有全文时 text 是全文（与 url-fetch 一致），snippet 才是短摘录。
      text: "# A page\n\nBody text.",
      snippet: "Snippet of the page.",
      score: 0.91,
    });
    expect(document.markdown).toBe("# A page\n\nBody text.");
    expect(document.provenance.provider).toBe("tavily");
    expect(document.provenance.retrievalMethod).toBe("api_search");
    expect(document.extensions).toMatchObject({
      serviceRequestId: "tvly-req-1",
      contentScope: "full",
      usageCredits: 1,
    });
    expect(calls[0]?.headers?.Authorization).toBe("Bearer tvly-first-secret");
  });

  it("does not request raw content when the caller did not ask for it", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, { query: "hello" });

    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.include_raw_content).toBeUndefined();
    expect(body.query).toBe("hello");
  });

  it("asks for usage metadata when enabled in deployment options", async () => {
    const { calls } = harness(() => ({ status: 200, body: searchBody() }), poolState);
    // 部署层默认开启用量上报：新建一个带该选项的实例写入同一个调用记录。
    const transport: HttpTransport = {
      id: "direct",
      request: async ({ url, headers, body }: TransportRequest): Promise<TransportResponse> => {
        calls.push({ url, headers, body });
        return { status: 200, headers: new Headers(), body: searchBody() };
      },
    };
    const transports = new TransportRegistry();
    transports.register(transport);
    const withUsage = tavilyPlugin.factories[0]!.create(
      "tavily",
      { type: "tavily", transport: { primary: "direct", fallback: [] }, options: { include_usage: true } },
      {
        transports,
        credentials: { poolForProvider: () => ({ poolId: "tavily-main", pool: new CredentialPool(poolState) }) },
      },
    );

    await withUsage.search(ctx, { query: "x" });

    const body = JSON.parse(calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
    expect(body.include_usage).toBe(true);
  });

  it("round-robins credentials across requests", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, { query: "one" });
    await provider.search(ctx, { query: "two" });

    expect(calls.map((call) => call.headers?.Authorization)).toEqual([
      "Bearer tvly-first-secret",
      "Bearer tvly-second-secret",
    ]);
  });

  it("surfaces a rate limit without echoing the upstream message", async () => {
    const { provider } = harness(() => ({
      status: 429,
      headers: { "retry-after": "42" },
      body: JSON.stringify({ detail: { error: "Your request has been blocked due to excessive requests." } }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(String(error)).not.toContain("excessive requests");
  });

  it("maps an invalid key to an upstream auth failure", async () => {
    const { provider } = harness(() => ({
      status: 401,
      body: JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(String(error)).not.toContain("invalid API key");
  });

  it("rejects provider options Tavily does not understand", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchBody() }));

    await expect(provider.search(ctx, {
      query: "x",
      providerOptions: { tavily: { notARealOption: true } },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("routes provider options only to Tavily", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, {
      query: "x",
      providerOptions: { tavily: { topic: "news" }, exa: { type: "deep" } },
    });

    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.topic).toBe("news");
    expect(body.type).toBeUndefined();
  });
});

describe("Tavily error classification", () => {
  it("classifies 432 as a credential-scoped quota block", () => {
    expect(classifyTavilyFailure(432, new Headers(), "{}")).toMatchObject({
      category: "quota",
      scope: "credential",
    });
  });

  it("classifies 433 as an account-scoped quota block", () => {
    expect(classifyTavilyFailure(433, new Headers(), "{}")).toMatchObject({
      category: "quota",
      scope: "account",
    });
  });

  it("classifies 403 as permission rather than an invalid key", () => {
    expect(classifyTavilyFailure(403, new Headers(), "{}")).toMatchObject({
      category: "permission",
      scope: "unknown",
    });
  });

  it("classifies 429 with Retry-After as credential-scoped rate limiting", () => {
    const failure = classifyTavilyFailure(429, new Headers({ "retry-after": "30" }), "{}");
    expect(failure).toMatchObject({ category: "rate_limited", scope: "credential" });
    expect(failure?.retryAfterMs).toBe(30_000);
  });

  it("classifies 400 as a request-level failure", () => {
    expect(classifyTavilyFailure(400, new Headers(), "{}")).toMatchObject({
      category: "invalid_request",
      scope: "request",
    });
  });

  it("classifies server errors as an unknown-scope upstream fault", () => {
    expect(classifyTavilyFailure(503, new Headers(), "{}")).toMatchObject({
      category: "upstream",
      scope: "service",
    });
  });
});

describe("Tavily extract", () => {
  const extractBody = (results: Array<{ url: string; raw_content?: string; error?: string }>) => JSON.stringify({
    response_time: 0.4,
    results: results.filter((entry) => !entry.error).map((entry) => ({ url: entry.url, raw_content: entry.raw_content ?? "" })),
    failed_results: results.filter((entry) => entry.error).map((entry) => ({ url: entry.url, error: entry.error })),
    usage: { credits: 1 },
  });

  it("associates results by input index rather than response order", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: extractBody([
        { url: "https://b.example/two", raw_content: "B content" },
        { url: "https://a.example/one", error: "blocked by the origin" },
      ]),
    }));

    const request: ExtractRequest = {
      urls: ["https://a.example/one", "https://b.example/two"],
      sources: ["tavily"],
    };
    const { items } = await provider.extract!(ctx, request);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ index: 0, url: "https://a.example/one", status: "failed" });
    expect(items[1]).toMatchObject({ index: 1, url: "https://b.example/two", status: "success" });
    expect((items[0]?.error?.message ?? "")).not.toContain("blocked by the origin");
  });

  it("treats a URL absent from both lists as failed instead of dropping it", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: extractBody([{ url: "https://b.example/two", raw_content: "B" }]),
    }));

    const { items } = await provider.extract!(ctx, {
      urls: ["https://a.example/one", "https://b.example/two"],
      sources: ["tavily"],
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.status).toBe("failed");
    expect(items[1]?.status).toBe("success");
  });

  it("splits extracts that exceed the native batch size", async () => {
    const { provider, calls } = harness(() => ({
      status: 200,
      body: extractBody([]),
    }));

    const urls = Array.from({ length: 45 }, (_, index) => `https://example.com/${index}`);
    await provider.extract!(ctx, { urls, sources: ["tavily"] });

    const batchSizes = calls
      .filter((call) => call.url.endsWith("/extract"))
      .map((call) => (JSON.parse(call.body ?? "{}") as { urls?: string[] }).urls?.length ?? 0);
    expect(batchSizes).toEqual([20, 20, 5]);
  });

  it("reports an all-failed response as failed items without leaking upstream text", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: JSON.stringify({ results: [], failed_results: [{ url: "https://a.example/one", error: "secret detail" }] }),
    }));

    const { items } = await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["tavily"] });
    const serialized = JSON.stringify(items);

    expect(items.every((item: ExtractItem) => item.status === "failed")).toBe(true);
    expect(serialized).not.toContain("secret detail");
  });
});

describe("Tavily usage", () => {
  const usageEnvelope = (key: unknown, account: unknown) => JSON.stringify({ key, account });

  it("maps official key and account usage with their units", async () => {
    const { provider, calls } = harness((path) => ({
      status: 200,
      body: path.endsWith("/usage")
        ? usageEnvelope({ usage: 150, limit: 1000 }, { usage: 500, plan_limit: 5000 })
        : JSON.stringify({ results: [] }),
    }));

    const report = await provider.usage!(ctx);

    expect(report).toMatchObject({ service: "tavily", accuracy: "official", supported: true });
    expect(report.entries).toEqual([
      { scope: "credential", used: 150, limit: 1000, unit: "credits" },
      { scope: "account", used: 500, limit: 5000, unit: "credits" },
    ]);
    // 用量查询必须用 GET，不能拿搜索请求体去问。
    expect(calls.at(-1)?.url).toContain("/usage");
  });

  it("omits entries instead of inventing zeros when the field is absent", async () => {
    const { provider } = harness((path) => ({
      status: 200,
      body: path.endsWith("/usage")
        ? usageEnvelope({ usage: 42, limit: null }, {})
        : JSON.stringify({ results: [] }),
    }));

    const report = await provider.usage!(ctx);

    // 未知的账号用量不得显示为 0；limit: null 表示无上限，与“未知”不同。
    expect(report.entries).toEqual([
      { scope: "credential", used: 42, limit: null, unit: "credits" },
    ]);
  });

  it("reports unsupported usage without a fabricated empty report", async () => {
    const { provider } = harness(() => ({
      status: 400,
      body: JSON.stringify({ detail: { error: "bad" } }),
    }));

    const error = await provider.usage!(ctx).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
