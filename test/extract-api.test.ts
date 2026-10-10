import { describe, expect, it } from "vitest";
import { createAdminTestServer } from "./helpers/admin-server.js";
import type { ExecutionDispatcher } from "../src/runtime/dispatcher.js";
import type { ExtractItem } from "../src/contracts/extract.js";

const extractPayload = {
  urls: ["https://a.example/one", "https://b.example/two"],
  sources: ["tavily"],
};

function withExtract(
  outputs: Record<string, ExtractItem[]>,
  failures: Record<string, { code: string; message: string }> = {},
) {
  const server = createAdminTestServer({
    // 注册两个 Provider：部分成功用例需要同时派发 tavily 与 exa。
    providers: { tavily: { type: "tavily" }, exa: { type: "exa" } },
    routes: { default: { providers: ["tavily"] } },
  });

  const dispatcher = server.context.dispatcher as unknown as {
    extract: ExecutionDispatcher["extract"];
  };
  dispatcher.extract = async (providerId) => {
    const failure = failures[providerId];
    if (failure) {
      const error = new Error(failure.message);
      Object.assign(error, { code: failure.code, retryable: false });
      throw error;
    }
    return { runtimeId: "runner-1", output: { items: outputs[providerId] ?? [] } };
  };

  return server;
}

describe("POST /v1/extract", () => {
  it("rejects unauthenticated requests", async () => {
    const { app } = withExtract({});

    const response = await app.inject({
      method: "POST",
      url: "/v1/extract",
      payload: extractPayload,
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a request without sources", async () => {
    const { app } = withExtract({});

    const response = await app.inject({
      method: "POST",
      url: "/v1/extract",
      headers: { authorization: "Bearer admin-test-key" },
      payload: { urls: ["https://a.example"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects non-http urls before any dispatch", async () => {
    const { app } = withExtract({});

    const response = await app.inject({
      method: "POST",
      url: "/v1/extract",
      headers: { authorization: "Bearer admin-test-key" },
      payload: { urls: ["file:///etc/passwd"], sources: ["tavily"] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns items correlated to the input order", async () => {
    const { app } = withExtract({
      tavily: [
        { index: 1, url: "https://b.example/two", status: "success" },
        { index: 0, url: "https://a.example/one", status: "success" },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/extract",
      headers: { authorization: "Bearer admin-test-key" },
      payload: extractPayload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("completed");
    expect(body.items.map((item: { index: number }) => item.index)).toEqual([0, 1]);
    expect(body.items.map((item: { url: string }) => item.url))
      .toEqual(["https://a.example/one", "https://b.example/two"]);
    expect(body.meta.providers.tavily).toMatchObject({ status: "success", runtimeId: "runner-1" });
  });

  it("keeps partial results distinguishable from total failure", async () => {
    const { app } = withExtract(
      {
        tavily: [{
          index: 0,
          url: "https://a.example/one",
          status: "failed",
          error: { code: "CONTENT_UNAVAILABLE", message: "blocked", retryable: false },
        }],
      },
      { exa: { code: "RUNTIME_OFFLINE", message: "offline" } },
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/extract",
      headers: { authorization: "Bearer admin-test-key" },
      payload: { urls: ["https://a.example/one"], sources: ["tavily", "exa"] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("failed");
    expect(body.meta.providers.exa).toMatchObject({ status: "failed", error: { code: "RUNTIME_OFFLINE" } });
  });

  it("is rejected without the API key like search", async () => {
    const { app } = withExtract({});

    const searchResponse = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
    const extractResponse = await app.inject({ method: "POST", url: "/v1/extract", payload: extractPayload });

    expect(searchResponse.statusCode).toBe(extractResponse.statusCode);
    expect(extractResponse.statusCode).toBe(401);
  });
});
