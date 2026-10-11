import { describe, expect, it } from "vitest";
import { CredentialPool } from "../src/runner/credentials/pool.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import type { ProviderContext, ProviderFactoryContext } from "../src/providers/types.js";
import type { ExtractRequest } from "../src/contracts/extract.js";
import { classifyExaFailure } from "../src/providers/exa/errors.js";
import exaPlugin from "../src/providers/exa/index.js";

const ctx: ProviderContext = { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1", jobId: "job-1" };

const poolState: CredentialRuntimeState = {
  version: 1,
  pools: [{ id: "exa-main", service: "exa", name: "Exa", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "exa-main", name: "primary", secret: "exa-first-secret", enabled: true, createdAt: 1 },
    { id: "key-2", poolId: "exa-main", name: "backup", secret: "exa-second-secret", enabled: true, createdAt: 2 },
  ],
  bindings: { exa: "exa-main" },
  state: {},
};

interface RecordedCall {
  url: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

/** 记录每次上游调用，并按路径返回预设响应。 */
function harness(
  respond: (path: string, body: Record<string, unknown>) => { status: number; headers?: Record<string, string>; body: string },
  state: CredentialRuntimeState = poolState,
) {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = {
    id: "direct",
    request: async ({ url, headers, body }: TransportRequest): Promise<TransportResponse> => {
      calls.push({ url, headers, body });
      const path = new URL(url).pathname;
      const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
      const result = respond(path, parsed);
      return { status: result.status, headers: new Headers(result.headers ?? {}), body: result.body };
    },
  };

  const transports = new TransportRegistry();
  transports.register(transport);
  const pool = new CredentialPool(state);
  const context: ProviderFactoryContext = {
    transports,
    credentials: { poolForProvider: () => ({ poolId: "exa-main", pool }) },
  };

  const provider = exaPlugin.factories[0]!.create(
    "exa",
    { type: "exa", transport: { primary: "direct", fallback: [] }, options: {} },
    context,
  );

  return { provider, calls, pool };
}

const searchBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  requestId: "exa-req-1",
  searchType: "auto",
  results: [
    {
      id: "https://a.example/page",
      url: "https://a.example/page",
      title: "A page",
      author: "Ada Lovelace",
      publishedDate: "2026-01-02T00:00:00.000Z",
      score: 0.91,
      text: "Full page text.",
      highlights: ["first highlight", "second highlight"],
      summary: "Exa generated summary.",
    },
  ],
  costDollars: { total: 0.007 },
  ...overrides,
});

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
}

describe("Exa search", () => {
  it("maps results into SearchDocument with structured provenance", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    const { items } = await provider.search(ctx, { query: "hello", content: { mode: "full" } });

    expect(items).toHaveLength(1);
    const document = items[0]!;
    expect(document).toMatchObject({
      url: "https://a.example/page",
      title: "A page",
      text: "Full page text.",
      snippet: "Exa generated summary.",
      publishedAt: "2026-01-02T00:00:00.000Z",
      score: 0.91,
    });
    // Exa 不产出 Markdown：绝不把纯文本填进 markdown 字段。
    expect(document.markdown).toBeUndefined();
    expect(document.provenance).toMatchObject({
      provider: "exa",
      retrievalMethod: "api_search",
      providerItemId: "https://a.example/page",
    });
    expect(document.extensions).toMatchObject({
      serviceRequestId: "exa-req-1",
      contentScope: "full",
      contentFormat: "text",
      usageCostUsd: 0.007,
      searchType: "auto",
      author: "Ada Lovelace",
      providerGeneratedSummary: "Exa generated summary.",
    });
    // Exa 认证头是 x-api-key，不是 Bearer。
    expect(calls[0]?.headers?.["x-api-key"]).toBe("exa-first-secret");
    expect(calls[0]?.url).toContain("api.exa.ai/search");
  });

  it("does not buy contents when the caller did not ask for them", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, { query: "hello" });

    const body = bodyOf(calls[0]);
    expect(body.contents).toBeUndefined();
    expect(body.query).toBe("hello");
  });

  it("asks for a generated summary when the caller wants a summary", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, { query: "hello", content: { mode: "summary" } });

    expect(bodyOf(calls[0]).contents).toEqual({ summary: true });
  });

  it("marks content as truncated when a character cap was actually sent", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    const { items } = await provider.search(ctx, {
      query: "hello",
      content: { mode: "full", maxChars: 400 },
    });

    // maxChars 是调用方的显式约束，不能被静默丢掉。
    expect(bodyOf(calls[0]).contents).toEqual({ text: { maxCharacters: 400 } });
    // 截断的全文不是完整全文。
    expect(items[0]?.extensions).toMatchObject({ contentScope: "truncated" });
  });

  it("flags a requested full text that upstream did not return", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: searchBody({ results: [{ url: "https://a.example/page", title: "A page", highlights: ["snippet"] }] }),
    }));

    const { items } = await provider.search(ctx, { query: "hello", content: { mode: "full" } });

    expect(items[0]?.text).toBeUndefined();
    expect(items[0]?.snippet).toBe("snippet");
    expect(items[0]?.extensions).toMatchObject({
      contentScope: "snippet",
      requestedFullContent: true,
      contentUnavailable: true,
    });
  });

  it("records the real content format when the caller asked for markdown", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchBody() }));

    const { items } = await provider.search(ctx, { query: "hello", content: { mode: "full", format: "markdown" } });

    expect(items[0]?.markdown).toBeUndefined();
    expect(items[0]?.extensions).toMatchObject({ contentFormat: "text", requestedFormat: "markdown" });
  });

  it("keeps the query independent of the numResults derived from limit", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, { query: "hello", limit: 5, providerOptions: { exa: { type: "fast", category: "news" } } });

    expect(bodyOf(calls[0])).toMatchObject({ query: "hello", numResults: 5, type: "fast", category: "news" });
  });

  it("round-robins credentials across requests", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, { query: "one" });
    await provider.search(ctx, { query: "two" });

    expect(calls.map((call) => call.headers?.["x-api-key"])).toEqual(["exa-first-secret", "exa-second-secret"]);
  });

  it("routes provider options only to Exa", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: searchBody() }));

    await provider.search(ctx, {
      query: "x",
      providerOptions: { exa: { category: "research paper" }, tavily: { topic: "news" } },
    });

    const body = bodyOf(calls[0]);
    expect(body.category).toBe("research paper");
    expect(body.topic).toBeUndefined();
  });

  it("rejects provider options Exa does not understand", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchBody() }));

    await expect(provider.search(ctx, {
      query: "x",
      providerOptions: { exa: { livecrawl: "always" } },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects a contents option that is not an object instead of ignoring it", async () => {
    const { provider } = harness(() => ({ status: 200, body: searchBody() }));

    await expect(provider.search(ctx, {
      query: "x",
      providerOptions: { exa: { contents: true } },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("surfaces a rate limit without echoing the upstream message", async () => {
    const { provider } = harness(() => ({
      status: 429,
      headers: { "retry-after": "42" },
      body: JSON.stringify({ requestId: "r", error: "too many requests from this team", tag: "RATE_LIMIT" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(String(error)).not.toContain("too many requests");
  });

  it("maps an invalid key to an upstream auth failure", async () => {
    const { provider } = harness(() => ({
      status: 401,
      body: JSON.stringify({ requestId: "r", error: "invalid api key", tag: "INVALID_API_KEY" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(String(error)).not.toContain("invalid api key");
  });

  it("isolates the failing key on 402 instead of blocking the whole account", async () => {
    const { provider, pool } = harness(() => ({
      status: 402,
      body: JSON.stringify({ requestId: "r", error: "credits exhausted", tag: "NO_MORE_CREDITS" }),
    }));

    const error = await provider.search(ctx, { query: "x" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    // 402 无法区分「账号余额」与「单 Key 预算」，只隔离当前 Key；
    // 若真是账号级问题，同组其他 Key 会各自上报后收敛，不会误伤整个账号组。
    expect(pool.availability("key-1")).toBe("quota_blocked");
    expect(pool.availability("key-2")).toBe("available");
  });

  it("cools down the active key on 429 with Retry-After", async () => {
    const { provider, pool } = harness(() => ({
      status: 429,
      headers: { "retry-after": "30" },
      body: JSON.stringify({ error: "rate limit exceeded" }),
    }));

    await provider.search(ctx, { query: "x" }).catch(() => undefined);

    expect(pool.availability("key-1")).toBe("cooling");
    expect(pool.availability("key-2")).toBe("available");
  });

  it("fails closed when no credential service is provided", () => {
    const transports = new TransportRegistry();

    expect(() => exaPlugin.factories[0]!.create(
      "exa",
      { type: "exa", options: {} },
      { transports },
    )).toThrowError(/credential pool/i);
  });

  it("declares only the capabilities it implements", () => {
    // 不声明 usage：Exa 普通 Key 没有用量端点，声明了就是撒谎。
    expect(exaPlugin.factories[0]!.capabilities).toEqual(["search", "extract"]);
    const provider = harness(() => ({ status: 200, body: searchBody() })).provider;
    expect(provider.usage).toBeUndefined();
  });
});

describe("Exa error classification", () => {
  it("classifies 402 as a credential-scoped quota block", () => {
    expect(classifyExaFailure(402, new Headers(), "{}")).toMatchObject({
      category: "quota",
      scope: "credential",
    });
  });

  it("classifies 429 with Retry-After as credential-scoped rate limiting", () => {
    const failure = classifyExaFailure(429, new Headers({ "retry-after": "30" }), "{}");
    expect(failure).toMatchObject({ category: "rate_limited", scope: "credential" });
    expect(failure?.retryAfterMs).toBe(30_000);
  });

  it("classifies 403 as permission rather than an invalid key", () => {
    expect(classifyExaFailure(403, new Headers(), "{}")).toMatchObject({
      category: "permission",
      scope: "unknown",
    });
  });

  it("classifies 400 as a request-level failure", () => {
    expect(classifyExaFailure(400, new Headers(), "{}")).toMatchObject({
      category: "invalid_request",
      scope: "request",
    });
  });

  it("classifies server errors as a service-scope upstream fault", () => {
    expect(classifyExaFailure(503, new Headers(), "{}")).toMatchObject({
      category: "upstream",
      scope: "service",
    });
  });
});

describe("Exa contents (extract)", () => {
  const contentsBody = (
    results: Array<{ url: string; text?: string }>,
    statuses: Array<{ id: string; status: string; tag?: string }> = [],
  ) => JSON.stringify({
    requestId: "exa-contents-1",
    results: results.map((entry) => ({ id: entry.url, url: entry.url, title: `Title of ${entry.url}`, text: entry.text ?? "" })),
    statuses: statuses.map((entry) => ({
      id: entry.id,
      status: entry.status,
      ...(entry.tag !== undefined ? { error: { tag: entry.tag, httpStatusCode: 404 } } : { error: null }),
    })),
    costDollars: { total: 0.002 },
  });

  it("associates results by input index rather than response order", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: contentsBody(
        [{ url: "https://b.example/two", text: "B content" }],
        [{ id: "https://a.example/one", status: "error", tag: "CRAWL_NOT_FOUND" }],
      ),
    }));

    const request: ExtractRequest = { urls: ["https://a.example/one", "https://b.example/two"], sources: ["exa"] };
    const { items } = await provider.extract!(ctx, request);

    expect(items.map((item) => [item.index, item.status])).toEqual([[0, "failed"], [1, "success"]]);
    expect(items[1]?.document).toMatchObject({
      url: "https://b.example/two",
      text: "B content",
      title: "Title of https://b.example/two",
    });
    expect(items[1]?.document?.markdown).toBeUndefined();
    expect(items[1]?.document?.extensions).toMatchObject({
      contentScope: "full",
      contentFormat: "text",
      serviceRequestId: "exa-contents-1",
      usageCostUsd: 0.002,
    });
  });

  it("maps a crawl timeout to a retryable per-item error", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: contentsBody([], [{ id: "https://a.example/one", status: "error", tag: "CRAWL_LIVECRAWL_TIMEOUT" }]),
    }));

    const { items } = await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["exa"] });

    expect(items[0]).toMatchObject({ status: "failed", error: { code: "TIMEOUT", retryable: true } });
  });

  it("treats a URL absent from both lists as failed instead of dropping it", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: contentsBody([{ url: "https://b.example/two", text: "B" }]),
    }));

    const { items } = await provider.extract!(ctx, {
      urls: ["https://a.example/one", "https://b.example/two"],
      sources: ["exa"],
    });

    expect(items.map((item) => item.status)).toEqual(["failed", "success"]);
    expect(items[0]?.error).toMatchObject({ code: "CONTENT_UNAVAILABLE" });
  });

  it("never echoes an unknown upstream error tag", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: JSON.stringify({
        results: [],
        statuses: [{ id: "https://a.example/one", status: "error", error: { tag: "WEIRD_INTERNAL_TAG" } }],
      }),
    }));

    const { items } = await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["exa"] });
    const serialized = JSON.stringify(items);

    expect(items[0]?.error).toMatchObject({ code: "CONTENT_UNAVAILABLE", retryable: false });
    expect(serialized).not.toContain("WEIRD_INTERNAL_TAG");
  });

  it("splits extracts that exceed the native batch size, keeping global indexes", async () => {
    const { provider, calls } = harness((_path, body) => ({
      status: 200,
      body: contentsBody((body.urls as string[]).map((url) => ({ url, text: `text for ${url}` }))),
    }));

    const urls = Array.from({ length: 150 }, (_, index) => `https://example.com/${index}`);
    const { items } = await provider.extract!(ctx, { urls, sources: ["exa"] });

    const batchSizes = calls
      .filter((call) => call.url.endsWith("/contents"))
      .map((call) => (bodyOf(call).urls as string[] | undefined)?.length ?? 0);
    expect(batchSizes).toEqual([100, 50]);

    // 第二批次不能从 0 重新计数：索引碰撞会让公共层把内容归到错误的 URL 上。
    expect(items).toHaveLength(150);
    expect(items.map((item) => item.index)).toEqual(urls.map((_, index) => index));
    expect(items[149]).toMatchObject({ index: 149, url: urls[149], status: "success" });
    expect(items[149]?.document?.text).toBe(`text for ${urls[149]}`);
  });

  it("requests text by default and honors a character cap", async () => {
    const { provider, calls } = harness(() => ({ status: 200, body: contentsBody([]) }));

    await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["exa"] });
    expect(bodyOf(calls[0]).text).toBe(true);

    await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["exa"], content: { maxChars: 200 } });
    expect(bodyOf(calls[1]).text).toEqual({ maxCharacters: 200 });
  });

  it("records the truncated scope when a character cap was sent", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: contentsBody([{ url: "https://a.example/one", text: "clipped" }]),
    }));

    const { items } = await provider.extract!(ctx, {
      urls: ["https://a.example/one"],
      sources: ["exa"],
      content: { maxChars: 200 },
    });

    expect(items[0]?.document?.extensions).toMatchObject({ contentScope: "truncated" });
  });

  it("keeps successful batches when a later batch fails", async () => {
    let call = 0;
    const { provider } = harness(() => {
      call += 1;
      if (call === 2) {
        return { status: 500, body: JSON.stringify({ error: "upstream down" }) };
      }
      return { status: 200, body: contentsBody([{ url: "https://b.example/two", text: "B" }]) };
    });

    const urls = [
      "https://b.example/two",
      ...Array.from({ length: 100 }, (_, index) => `https://example.com/${index}`),
    ];
    const { items } = await provider.extract!(ctx, { urls, sources: ["exa"] });

    expect(items).toHaveLength(101);
    expect(items[0]).toMatchObject({ index: 0, status: "success" });
    expect(items[1]).toMatchObject({ index: 1, status: "failed" });
    // 第二批只有 1 个 URL，失败项必须落在全局索引 100，而不是 0。
    expect(items[100]).toMatchObject({ index: 100, url: urls[100], status: "failed" });
  });

  it("surfaces a service-level failure when every batch fails", async () => {
    const { provider } = harness(() => ({ status: 401, body: JSON.stringify({ error: "invalid api key" }) }));

    const error = await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["exa"] })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(String(error)).not.toContain("invalid api key");
  });

  it("never leaks the API key into extracted documents", async () => {
    const { provider } = harness(() => ({
      status: 200,
      body: contentsBody([{ url: "https://a.example/one", text: "content" }]),
    }));

    const { items } = await provider.extract!(ctx, { urls: ["https://a.example/one"], sources: ["exa"] });

    expect(JSON.stringify(items)).not.toContain("exa-first-secret");
  });
});
