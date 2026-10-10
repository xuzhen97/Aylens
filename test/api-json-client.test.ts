import { describe, expect, it } from "vitest";
import { ApiJsonClient } from "../src/api-client/json-client.js";
import type { HttpTransport, TransportResponse } from "../src/transports/types.js";

function fakeTransport(
  impl: (url: string, request: { headers?: Record<string, string> | undefined; method?: string | undefined }) => TransportResponse,
): HttpTransport {
  return {
    id: "direct",
    request: async ({ url, headers, method }) => impl(url, { headers, method }),
  };
}

describe("ApiJsonClient", () => {
  it("parses Retry-After seconds into milliseconds", () => {
    expect(ApiJsonClient.parseRetryAfterMs(new Headers({ "retry-after": "60" }))).toBe(60_000);
  });

  it("accepts an HTTP date in Retry-After", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const headers = new Headers({ "retry-after": new Date(now + 30_000).toUTCString() });
    const parsed = ApiJsonClient.parseRetryAfterMs(headers, now);
    expect(parsed).toBeGreaterThan(20_000);
    expect(parsed).toBeLessThanOrEqual(31_000);
  });

  it("ignores an unparsable Retry-After", () => {
    expect(ApiJsonClient.parseRetryAfterMs(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(ApiJsonClient.parseRetryAfterMs(new Headers())).toBeUndefined();
  });

  it("sends the request through the configured transport and returns its body", async () => {
    let seen: { url: string; headers?: Record<string, string> | undefined; method?: string | undefined } | undefined;
    const client = new ApiJsonClient(
      fakeTransport((url, request) => {
        seen = { url, ...request };
        return { status: 200, headers: new Headers(), body: "{\"results\":[]}" };
      }),
      { allowedOrigin: "https://api.tavily.com" },
    );

    const result = await client.send({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: { Authorization: "Bearer tvly-secret" },
      body: "{\"query\":\"x\"}",
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("{\"results\":[]}");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers?.Authorization).toBe("Bearer tvly-secret");
  });

  it("refuses to send credentials to a foreign origin", async () => {
    const client = new ApiJsonClient(
      fakeTransport(() => ({ status: 200, headers: new Headers(), body: "{}" })),
      { allowedOrigin: "https://api.tavily.com" },
    );

    await expect(client.send({
      url: "https://evil.example/search",
      method: "POST",
      headers: { Authorization: "Bearer tvly-secret" },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "URL_FORBIDDEN" });
  });

  it("treats redirects as upstream errors so auth is never replayed", async () => {
    const client = new ApiJsonClient(
      fakeTransport(() => ({
        status: 302,
        headers: new Headers({ location: "https://evil.example/collect" }),
        body: "",
      })),
      { allowedOrigin: "https://api.tavily.com" },
    );

    await expect(client.send({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: { Authorization: "Bearer tvly-secret" },
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("rejects oversized bodies instead of truncating them silently", async () => {
    const client = new ApiJsonClient(
      fakeTransport(() => ({ status: 200, headers: new Headers(), body: "x".repeat(5_000) })),
      { allowedOrigin: "https://api.tavily.com", maxBytes: 1_024 },
    );

    await expect(client.send({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: {},
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("does not leak the response body in an error message", async () => {
    const client = new ApiJsonClient(
      fakeTransport(() => ({
        status: 200,
        headers: new Headers(),
        body: "SECRET_UPSTREAM_PAYLOAD",
      })),
      { allowedOrigin: "https://api.tavily.com", maxBytes: 10 },
    );

    const error = await client.send({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: {},
      timeoutMs: 1_000,
    }).catch((caught: unknown) => caught);

    expect(String(error)).not.toContain("SECRET_UPSTREAM_PAYLOAD");
  });

  it("exposes response headers for Retry-After handling", async () => {
    const client = new ApiJsonClient(
      fakeTransport(() => ({
        status: 429,
        headers: new Headers({ "retry-after": "7" }),
        body: "{}",
      })),
      { allowedOrigin: "https://api.tavily.com" },
    );

    const result = await client.send({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: {},
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(429);
    expect(ApiJsonClient.parseRetryAfterMs(result.headers)).toBe(7_000);
  });
});
