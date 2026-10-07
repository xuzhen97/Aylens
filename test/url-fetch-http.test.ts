import { describe, expect, it } from "vitest";

import { fetchHttpTarget } from "../src/providers/url-fetch/http-fetch.js";
import type { TransportRequest, TransportResponse, TransportResponsePolicy } from "../src/transports/types.js";

interface ScriptedResponse {
  status: number;
  location?: string;
  body?: string;
}

class ScriptedTransport {
  readonly id = "scripted";
  readonly calls: Array<{
    url: string;
    headers?: Record<string, string> | undefined;
    policy?: TransportResponsePolicy | undefined;
    signal?: AbortSignal | undefined;
  }> = [];

  constructor(private readonly script: ScriptedResponse[]) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push({
      url: request.url,
      headers: request.headers,
      policy: request.responsePolicy,
      signal: request.signal,
    });

    const next = this.script.shift();
    if (!next) throw new Error(`Unexpected request to ${request.url}`);

    const headers = new Headers();
    if (next.location !== undefined) headers.set("location", next.location);

    return { status: next.status, headers, body: next.body ?? "" };
  }
}

function publicPolicy(overrides: Partial<TransportResponsePolicy> = {}): TransportResponsePolicy {
  return {
    maxBytes: 2_000_000,
    maxDecodedBytes: 5_000_000,
    decode: "web",
    redirect: "manual",
    network: "public",
    ...overrides,
  };
}

async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("fetchHttpTarget", () => {
  it("returns the response when the target does not redirect", async () => {
    const transport = new ScriptedTransport([{ status: 200, body: "# Title" }]);

    const result = await fetchHttpTarget(
      new URL("https://example.test/"),
      transport,
      publicPolicy(),
      new AbortController().signal,
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("# Title");
    expect(result.url).toBe("https://example.test/");
  });

  it("follows redirects up to the limit and reports the final URL", async () => {
    const transport = new ScriptedTransport([
      { status: 301, location: "/a" },
      { status: 302, location: "https://cdn.test/b" },
      { status: 200, body: "done" },
    ]);

    const result = await fetchHttpTarget(
      new URL("https://example.test/"),
      transport,
      publicPolicy(),
      new AbortController().signal,
    );

    expect(result.url).toBe("https://cdn.test/b");
    expect(result.body).toBe("done");
    expect(transport.calls.map((call) => call.url)).toEqual([
      "https://example.test/",
      "https://example.test/a",
      "https://cdn.test/b",
    ]);
  });

  it("rejects a redirect to a non-public literal address", async () => {
    const transport = new ScriptedTransport([
      { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    ]);

    await expectRejection(
      fetchHttpTarget(new URL("https://example.test/"), transport, publicPolicy(), new AbortController().signal),
      "URL_FORBIDDEN",
    );
    // 必须在发起第二跳之前就拒绝。
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects a redirect to a non-http scheme", async () => {
    const transport = new ScriptedTransport([{ status: 302, location: "file:///etc/passwd" }]);

    await expectRejection(
      fetchHttpTarget(new URL("https://example.test/"), transport, publicPolicy(), new AbortController().signal),
      "URL_FORBIDDEN",
    );
  });

  it("rejects a redirect chain that exceeds the hop limit", async () => {
    const transport = new ScriptedTransport(
      Array.from({ length: 8 }, (_value, index) => ({ status: 302, location: `/hop-${index}` })),
    );

    await expectRejection(
      fetchHttpTarget(new URL("https://example.test/"), transport, publicPolicy(), new AbortController().signal),
      "UPSTREAM_ERROR",
    );
  });

  it("stops a redirect loop through the hop limit", async () => {
    const transport = new ScriptedTransport(
      Array.from({ length: 8 }, () => ({ status: 302, location: "/loop" })),
    );

    await expectRejection(
      fetchHttpTarget(new URL("https://example.test/"), transport, publicPolicy(), new AbortController().signal),
      "UPSTREAM_ERROR",
    );
    expect(transport.calls).toHaveLength(6);
  });

  it("sends no credentials and forwards the policy and signal to the transport", async () => {
    const transport = new ScriptedTransport([{ status: 200, body: "ok" }]);
    const controller = new AbortController();
    const policy = publicPolicy({ maxBytes: 1234 });

    await fetchHttpTarget(new URL("https://example.test/"), transport, policy, controller.signal);

    const [call] = transport.calls;

    const headerNames = Object.keys(call?.headers ?? {}).map((name) => name.toLowerCase());
    expect(call?.headers?.accept).toContain("text/markdown");
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("authorization");
    expect(call?.policy).toBe(policy);
    expect(call?.signal).toBe(controller.signal);
  });
});
