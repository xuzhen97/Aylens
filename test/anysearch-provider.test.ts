import { describe, expect, it } from "vitest";
import { CredentialPool } from "../src/runner/credentials/pool.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import type { ProviderContext, ProviderFactoryContext } from "../src/providers/types.js";
import { businessStatusOf, classifyAnySearchFailure } from "../src/providers/anysearch/errors.js";
import anySearchPlugin from "../src/providers/anysearch/index.js";

const ctx: ProviderContext = { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1", jobId: "job-1" };

const poolState: CredentialRuntimeState = {
  version: 1,
  pools: [{ id: "anysearch-main", service: "anysearch", name: "AnySearch", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "anysearch-main", name: "primary", secret: "as-first-secret", enabled: true, createdAt: 1 },
    { id: "key-2", poolId: "anysearch-main", name: "backup", secret: "as-second-secret", enabled: true, createdAt: 2 },
  ],
  bindings: { anysearch: "anysearch-main" },
  state: {},
};

interface RecordedCall {
  url: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

/** 记录调用、支持观测并发峰值的假 Transport（并发要真的重叠才测得出来）。 */
class RecordingTransport implements HttpTransport {
  readonly id = "direct";
  readonly calls: RecordedCall[] = [];
  maxObservedConcurrency = 0;

  private inFlight = 0;

  constructor(
    private readonly respond: (path: string, body: Record<string, unknown>) => {
      status: number;
      headers?: Record<string, string>;
      body: string;
    },
  ) {}

  async request({ url, headers, body }: TransportRequest): Promise<TransportResponse> {
    const path = new URL(url).pathname;
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
    this.calls.push({ url, headers, body });

    this.inFlight += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.inFlight);
    try {
      // 让出事件循环，使并发调用真的重叠。
      await new Promise((resolve) => setTimeout(resolve, 1));
      const result = this.respond(path, parsed);
      return { status: result.status, headers: new Headers(result.headers ?? {}), body: result.body };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function harness(
  respond: (path: string, body: Record<string, unknown>) => { status: number; headers?: Record<string, string>; body: string },
  state: CredentialRuntimeState = poolState,
  deploymentOptions: Record<string, unknown> = {},
) {
  const transport = new RecordingTransport(respond);
  const transports = new TransportRegistry();
  transports.register(transport);
  const pool = new CredentialPool(state);
  const context: ProviderFactoryContext = {
    transports,
    credentials: { poolForProvider: () => ({ poolId: "anysearch-main", pool }) },
  };

  const provider = anySearchPlugin.factories[0]!.create(
    "anysearch",
    { type: "anysearch", transport: { primary: "direct", fallback: [] }, options: deploymentOptions },
    context,
  );

  return { provider, calls: transport.calls, transport, pool };
}

const okEnvelope = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => JSON.stringify({
  code: 0,
  message: "success",
  request_id: "as-req-1",
  data,
  ...overrides,
});

const searchEnvelope = (
  results: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) => okEnvelope({
  results,
  metadata: { total_results: results.length, search_time_ms: 312 },
}, overrides);

const extractEnvelope = (url: string, content: string, overrides: Record<string, unknown> = {}) => okEnvelope({
  url,
  title: `Title of ${url}`,
  content,
}, overrides);

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
}

describe("AnySearch search", () => {
  it("maps results with honest content scope and provenance", async () => {
    const { provider, calls } = harness(() => ({
      status: 200,
      body: searchEnvelope([
        { title: "Go 1.26", url: "https://go.dev/doc/go1.26", snippet: "Short summary", content: "Cleaned content body" },
      ]),
    }));

    const { items } = await provider.search(ctx, { query: "Go 1.26" });

    expect(items).toHaveLength(1);
    const document = items[0]!;
    expect(document).toMatchObject({
      url: "https://go.dev/doc/go1.26",
      title: "Go 1.26",
      text: "Cleaned content body",
      snippet: "Short summary",
    });
    // 上游只承诺 cleaned content、不承诺全文 —— 不谎称 full。
    expect(document.markdown).toBeUndefined();
    expect(document.extensions).toMatchObject({
      contentScope: "partial",
      contentFormat: "text",
      serviceRequestId: "as-req-1",
      responseTimeMs: 312,
    });
    expect(document.provenance).toMatchObject({ provider: "anysearch", retrievalMethod: "api_search" });
    // 认证：Bearer，且**永不带匿名请求**。
    expect(calls[0]?.headers?.Authorization).toBe("Bearer as-first-secret");
    expect(calls[0]?.url).toContain("api.anysearch.com/v1/search");
  });

  it("fills markdown when the caller asks for markdown, because upstream really returns it", async () => {
    const { provider, calls } = harness(() => ({
      status: 200,
      body: searchEnvelope([{ title: "T", url: "https://a.example/x", content: "# Heading\n\nBody" }]),
    }));

    const { items } = await provider.search(ctx, { query: "x", content: { mode: "full", format: "markdown" } });

    expect(bodyOf(calls[0]).format).toBe("markdown");
    expect(items[0]?.markdown).toBe("# Heading\n\nBody");
    expect(items[0]?.text).toBe("# Heading\n\nBody");
    expect(items[0]?.extensions).toMatchObject({ contentFormat: "markdown" });
  });

  it("marks the truncation instead of silently capping limit at the upstream maximum", async () => {
    const { provider, calls } = harness(() => ({
      status: 200,
      body: searchEnvelope([{ url: "https://a.example/x" }]),
    }));

    // 上游 max_results 上限是 10，契约允许到 100：发 10，但必须留下痕迹。
    const { items } = await provider.search(ctx, { query: "x", limit: 25 });

    expect(bodyOf(calls[0]).max_results).toBe(10);
    expect(items[0]?.extensions).toMatchObject({ requestedLimit: 25, limitCappedTo: 10 });
  });

  it("passes a within-range limit straight through", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchEnvelope([]) }));

    await provider.search(ctx, { query: "x", limit: 5 });

    expect(bodyOf(calls[0]).max_results).toBe(5);
  });

  it("maps the generic language field but lets an explicit provider option win", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchEnvelope([]) }));

    await provider.search(ctx, { query: "x", language: "zh-CN" });
    expect(bodyOf(calls[0]).language).toBe("zh-CN");

    await provider.search(ctx, { query: "x", language: "zh-CN", providerOptions: { anysearch: { language: "en" } } });
    expect(bodyOf(calls[1]).language).toBe("en");
  });

  it("flags a summary request it cannot actually act on", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchEnvelope([{ url: "https://a.example/x" }]) }));

    const { items } = await provider.search(ctx, { query: "x", content: { mode: "summary" } });

    // 上游没有 summary 参数：如实标注，而不是假装照办。
    expect(items[0]?.extensions).toMatchObject({ requestedContentMode: "summary" });
  });

  it("flags a requested full text that upstream did not return", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: searchEnvelope([{ url: "https://a.example/x", snippet: "only a snippet" }]),
    }));

    const { items } = await provider.search(ctx, { query: "x", content: { mode: "full" } });

    expect(items[0]?.text).toBeUndefined();
    expect(items[0]?.extensions).toMatchObject({
      contentScope: "snippet",
      requestedFullContent: true,
      contentUnavailable: true,
    });
  });

  it("round-robins credentials across requests", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchEnvelope([]) }));

    await provider.search(ctx, { query: "one" });
    await provider.search(ctx, { query: "two" });

    expect(calls.map((call) => call.headers?.Authorization)).toEqual([
      "Bearer as-first-secret",
      "Bearer as-second-secret",
    ]);
  });

  it("rejects provider options AnySearch does not understand", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchEnvelope([]) }));

    await expect(provider.search(ctx, {
      query: "x",
      providerOptions: { anysearch: { notARealOption: true } },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects an unknown deployment option as a config error", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchEnvelope([]) }), poolState, { nope: true });

    await expect(provider.search(ctx, { query: "x" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("routes provider options only to AnySearch", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchEnvelope([]) }));

    await provider.search(ctx, {
      query: "x",
      providerOptions: { anysearch: { zone: "cn" }, exa: { type: "deep" }, tavily: { topic: "news" } },
    });

    const body = bodyOf(calls[0]);
    expect(body.zone).toBe("cn");
    expect(body.type).toBeUndefined();
    expect(body.topic).toBeUndefined();
  });
});

describe("AnySearch business-code failures", () => {
  it("treats HTTP 200 with a failing business code as a failure", async () => {
    const { provider, pool } = harness(() => ({
      status: 200,
      body: JSON.stringify({ code: -1, message: "Query is required.", request_id: "as-req-2" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", retryable: false });
    // 未知业务码不猜：不做凭据判定，Key 保持可用。
    expect(pool.availability("key-1")).toBe("available");
  });

  it("never echoes the upstream message, which may carry generated credentials", async () => {
    const sensitive = "Your account and API key have been automatically generated.\nusername=u1\npassword=p1\napi_key=as-generated-key";
    const { provider } = harness(() => ({
      status: 200,
      body: JSON.stringify({ code: -1, message: sensitive, request_id: "as-req-3" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);
    const serialized = `${String(error)}${JSON.stringify(error)}`;

    expect(serialized).not.toContain("as-generated-key");
    expect(serialized).not.toContain("password=p1");
  });

  it("maps the documented rate-limit business code and cools the key down", async () => {
    const { provider, pool } = harness(() => ({
      status: 200,
      headers: { "retry-after": "30" },
      body: JSON.stringify({ code: 42901, message: "rate limited", request_id: "as-req-4" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(pool.availability("key-1")).toBe("cooling");
    expect(pool.availability("key-2")).toBe("available");
  });

  it("knows which business codes it can justify and refuses to guess the rest", () => {
    expect(businessStatusOf(42901)).toBe(429);
    expect(businessStatusOf(402)).toBe(402);
    expect(businessStatusOf(-1)).toBeUndefined();
    expect(businessStatusOf(99999)).toBeUndefined();
  });
});

describe("AnySearch HTTP error classification", () => {
  it("isolates the failing key on 402 and never leaks the response body", async () => {
    const { provider, pool } = harness(() => ({
      status: 402,
      body: JSON.stringify({
        code: -1,
        message: "quota exhausted\nusername=u\npassword=p\napi_key=as-leaked-key",
        request_id: "as-req-5",
      }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    expect(pool.availability("key-1")).toBe("quota_blocked");
    expect(pool.availability("key-2")).toBe("available");
    expect(String(error)).not.toContain("as-leaked-key");
  });

  it("treats 403 as permission rather than an invalid key", async () => {
    const { provider, pool } = harness(() => ({
      status: 403,
      body: JSON.stringify({ code: -1, message: "Expired API key" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(pool.availability("key-1")).toBe("available");
  });

  it("treats 401 as an invalid key", async () => {
    const { provider, pool } = harness(() => ({
      status: 401,
      body: JSON.stringify({ code: -1, message: "Invalid API key." }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(pool.availability("key-1")).toBe("auth_failed");
  });

  it("classifies 415, 422 and 502 with the right scope", () => {
    expect(classifyAnySearchFailure("search", 415, new Headers(), "{}")).toMatchObject({
      category: "invalid_request",
      scope: "request",
    });
    // 422 只在 extract 出现：逐 URL 内容失败，不牵连 Key。
    expect(classifyAnySearchFailure("extract", 422, new Headers(), "{}")).toMatchObject({
      category: "item_content",
      scope: "request",
    });
    expect(classifyAnySearchFailure("search", 502, new Headers(), "{}")).toMatchObject({
      category: "upstream",
      scope: "service",
    });
  });
});

describe("AnySearch extract", () => {
  it("calls upstream once per URL with a body containing only the url", async () => {
    const { provider, calls } = harness((_path, body) => {
      const url = String(body.url);
      return { status: 200, body: extractEnvelope(url, `content of ${url}`) };
    });

    const urls = ["https://a.example/1", "https://b.example/2"];
    const { items } = await provider.extract!(ctx, { urls, sources: ["anysearch"] });

    expect(items.map((item) => [item.index, item.status])).toEqual([[0, "success"], [1, "success"]]);
    expect(items[1]?.document).toMatchObject({ url: urls[1], text: `content of ${urls[1]}` });
    // 上游要求 body 恰好一个对象、恰好一个键；多一个键就被 400 拒绝。
    expect(Object.keys(bodyOf(calls[0])).sort()).toEqual(["url"]);
    expect(calls).toHaveLength(2);
  });

  it("bounds concurrency, because upstream takes exactly one URL per call", async () => {
    const { provider, transport } = harness((_path, body) => {
      const url = String(body.url);
      return { status: 200, body: extractEnvelope(url, `content of ${url}`) };
    });

    const urls = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`);
    const { items } = await provider.extract!(ctx, { urls, sources: ["anysearch"] });

    expect(items).toHaveLength(6);
    expect(items.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(transport.maxObservedConcurrency).toBeLessThanOrEqual(2);
    expect(transport.maxObservedConcurrency).toBeGreaterThan(1);
  });

  it("honors a deployment override for the concurrency cap and rejects nonsense", async () => {
    const respond = (_path: string, body: Record<string, unknown>) => {
      const url = String(body.url);
      return { status: 200, body: extractEnvelope(url, "content") };
    };
    const urls = Array.from({ length: 4 }, (_, index) => `https://example.com/${index}`);

    const capped = harness(respond, poolState, { maxConcurrentExtracts: 4 });
    await capped.provider.extract!(ctx, { urls, sources: ["anysearch"] });
    expect(capped.transport.maxObservedConcurrency).toBeLessThanOrEqual(4);

    // 越界值明确报错，不静默回退默认值。
    expect(() => harness(respond, poolState, { maxConcurrentExtracts: 99 }))
      .toThrowError(/maxConcurrentExtracts/);
  });

  it("never sends the adapter-only option upstream", async () => {
    const { provider, calls } = harness((_path, body) => {
      const url = String(body.url);
      return { status: 200, body: extractEnvelope(url, "content") };
    }, poolState, { maxConcurrentExtracts: 1 });

    await provider.extract!(ctx, { urls: ["https://a.example/1"], sources: ["anysearch"] });

    expect(Object.keys(bodyOf(calls[0]))).toEqual(["url"]);
  });

  it("marks one failing URL as a failure while keeping the others", async () => {
    const { provider, pool } = harness((_path, body) => {
      const url = String(body.url);
      if (url.endsWith("/2")) {
        return {
          status: 422,
          body: JSON.stringify({ code: -1, message: "Unable to extract", request_id: "as-req-6", error_code: "extract_failed" }),
        };
      }
      return { status: 200, body: extractEnvelope(url, `content of ${url}`) };
    }, poolState, { maxConcurrentExtracts: 1 });

    const urls = ["https://a.example/1", "https://b.example/2", "https://c.example/3"];
    const { items } = await provider.extract!(ctx, { urls, sources: ["anysearch"] });

    expect(items.map((item) => item.status)).toEqual(["success", "failed", "success"]);
    expect(items[1]).toMatchObject({ index: 1, url: urls[1] });
    expect(items[1]?.error).toMatchObject({ code: "CONTENT_UNAVAILABLE", retryable: false });
    // 逐 URL 提取失败不能把 Key 标坏。
    expect(pool.availability("key-1")).toBe("available");
    expect(pool.availability("key-2")).toBe("available");
  });

  it("treats a 200 without usable content as a per-URL failure, not a success", async () => {
    const { provider, pool } = harness(() => ({
      status: 200,
      body: okEnvelope({ url: "https://a.example/1", title: "No content here" }),
    }));

    const { items } = await provider.extract!(ctx, { urls: ["https://a.example/1"], sources: ["anysearch"] });

    expect(items[0]).toMatchObject({ status: "failed" });
    expect(items[0]?.error).toMatchObject({ code: "CONTENT_UNAVAILABLE" });
    expect(items[0]?.document).toBeUndefined();
    expect(pool.availability("key-1")).toBe("available");
  });

  it("rejects any extract option, because upstream allows only the url field", async () => {
    const { provider } = harness(() => ({ status: 200, body: extractEnvelope("https://a.example/1", "x") }));

    await expect(provider.extract!(ctx, {
      urls: ["https://a.example/1"],
      sources: ["anysearch"],
      providerOptions: { anysearch: { format: "markdown" } },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("surfaces a service-level failure when nothing succeeded", async () => {
    const { provider } = harness(() => ({
      status: 401,
      body: JSON.stringify({ code: -1, message: "Invalid API key. api_key=as-leaked-key" }),
    }));

    const error = await provider.extract!(ctx, { urls: ["https://a.example/1"], sources: ["anysearch"] })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(String(error)).not.toContain("as-leaked-key");
  });

  it("never writes the credential or upstream content into the documents", async () => {
    const { provider } = harness((_path, body) => {
      const url = String(body.url);
      return { status: 200, body: extractEnvelope(url, "page body") };
    });

    const { items } = await provider.extract!(ctx, { urls: ["https://a.example/1"], sources: ["anysearch"] });
    const serialized = JSON.stringify(items);

    expect(serialized).not.toContain("as-first-secret");
    expect(serialized).not.toContain("as-second-secret");
  });
});

describe("AnySearch factory contract", () => {
  it("declares only the capabilities it implements", () => {
    // 不声明 usage：官方端点清单里没有 Key 用量查询。
    expect(anySearchPlugin.factories[0]!.capabilities).toEqual(["search", "extract"]);
    const provider = harness(() => ({ status: 200, body: searchEnvelope([]) })).provider;
    expect(provider.usage).toBeUndefined();
  });

  it("fails closed when no credential service is provided", () => {
    const transports = new TransportRegistry();

    expect(() => anySearchPlugin.factories[0]!.create(
      "anysearch",
      { type: "anysearch", options: {} },
      { transports },
    )).toThrowError(/credential pool/i);
  });

  it("does not fall back to anonymous access when the request is unauthorized", async () => {
    const { provider, calls } = harness(() => ({
      status: 401,
      body: JSON.stringify({ code: -1, message: "Invalid API key." }),
    }));

    await provider.search(ctx, { query: "x" }).catch(() => undefined);

    // 一次请求就是一次请求：不重试、更不摘掉 Authorization 头去走匿名。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers?.Authorization).toBe("Bearer as-first-secret");
  });
});
