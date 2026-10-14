import { afterEach, describe, expect, it, vi } from "vitest";
import { AylensBridgeError, AylensClient, type BridgeConfig } from "../src/client.js";

const config: BridgeConfig = {
  baseUrl: "http://127.0.0.1:3000",
  apiKey: "dev-key",
  requestTimeoutMs: 50,
  allowAuthLogin: false,
};

function client(): AylensClient {
  return new AylensClient(config);
}

/** fetch 打桩：永远挂起，直到传入的 signal 被 abort。 */
function stubHangingFetch(): void {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    await new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    throw new Error("unreachable");
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AylensClient 错误映射", () => {
  it("HTTP 401 映射成 AUTH_FAILED，且消息里带上网关返回的 detail", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );
    await expect(client().get("/v1/providers")).rejects.toMatchObject({
      code: "AUTH_FAILED",
      status: 401,
    });
    await expect(client().get("/v1/providers")).rejects.toThrow(/bad key/);
  });

  it("HTTP 404 映射成 NOT_FOUND，HTTP 503 映射成 GATEWAY_ERROR", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    await expect(client().get("/v1/audit/x")).rejects.toMatchObject({ code: "NOT_FOUND" });

    vi.stubGlobal("fetch", async () => new Response("boom", { status: 503 }));
    await expect(client().get("/v1/audit/x")).rejects.toMatchObject({ code: "GATEWAY_ERROR" });
  });

  it("网络失败映射成 GATEWAY_UNREACHABLE，并带上 baseUrl", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client().get("/health")).rejects.toMatchObject({ code: "GATEWAY_UNREACHABLE" });
    await expect(client().get("/health")).rejects.toThrow(/127\.0\.0\.1:3000/);
  });

  it("200 但没有 JSON body 映射成 GATEWAY_ERROR", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    await expect(client().get("/health")).rejects.toMatchObject({ code: "GATEWAY_ERROR" });
  });

  it("超时映射成 TIMEOUT，且消息里带上毫秒数与调参提示", async () => {
    stubHangingFetch();
    await expect(client().get("/health")).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(client().get("/health")).rejects.toThrow(/REQUEST_TIMEOUT_MS/);
  });

  it("调用方传入的 signal 能取消请求，且报 ABORTED 而不是 TIMEOUT", async () => {
    stubHangingFetch();
    const controller = new AbortController();
    const pending = client().get("/health", undefined, controller.signal);
    controller.abort(new DOMException("aborted by caller", "AbortError"));
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("超时（无人取消）仍然报 TIMEOUT", async () => {
    stubHangingFetch();
    const controller = new AbortController();
    // 不主动 abort：只等 requestTimeoutMs(50ms) 自然超时
    await expect(client().get("/health", undefined, controller.signal)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});

describe("AylensClient 请求装配", () => {
  it("GET 查询参数写进 URL，POST body 序列化成 JSON 并带上鉴权头", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await client().get("/v1/audit", { requestId: "req-1" });
    await client().post("/v1/search", { query: "x" });

    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/v1/audit?requestId=req-1");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ query: "x" }));
    expect((calls[1]?.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer dev-key");
  });

  it("AylensBridgeError 带 code 与 status，且是 Error 的子类", () => {
    const error = new AylensBridgeError("NO_RUNTIME", "no runner", 503);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AylensBridgeError");
    expect(error.code).toBe("NO_RUNTIME");
    expect(error.status).toBe(503);
  });
});
