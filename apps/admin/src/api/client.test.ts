import { describe, expect, it, vi } from "vitest";
import { createAdminClient } from "./client.js";

const searchResponse = {
  requestId: "r",
  traceId: "t",
  status: "completed",
  items: [],
  meta: { providers: {} },
};

describe("Admin API client", () => {
  it("uses same-origin cookies and CSRF for writes, never Bearer credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(searchResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createAdminClient({
      fetchImpl,
      getCsrfToken: () => "csrf-secret",
      onUnauthorized: vi.fn(),
    });

    await client.search({ query: "hello" });
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/v1/search");
    expect(options?.credentials).toBe("same-origin");
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe("csrf-secret");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
  });

  it("sends the API key only to the login endpoint and handles 204 logout", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, expiresAt: 10, csrfToken: "csrf" }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createAdminClient({ fetchImpl, getCsrfToken: () => "csrf", onUnauthorized: vi.fn() });
    await client.login("secret key");
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({ apiKey: "secret key" });
    await client.logout();
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/v1/admin/session/logout");
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("x-csrf-token")).toBe("csrf");
  });

  it("normalizes 401 and rate-limit responses without leaking response bodies", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "AUTH_FAILED", message: "Invalid API key" } }), { status: 401, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("too many", { status: 429, headers: { "retry-after": "17" } }));
    const client = createAdminClient({ fetchImpl, getCsrfToken: () => undefined, onUnauthorized });
    await expect(client.session()).rejects.toMatchObject({ status: 401, code: "AUTH_FAILED" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    await expect(client.login("bad")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 17 });
  });
});
