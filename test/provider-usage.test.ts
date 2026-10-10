import { describe, expect, it } from "vitest";
import { ExecutionDispatcher } from "../src/runtime/dispatcher.js";
import { RetrievalError } from "../src/core/errors.js";
import { createAdminTestServer } from "./helpers/admin-server.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import type { RuntimeRegistry } from "../src/runtime/registry.js";
import type { RunnerSessionManager } from "../src/runtime/runner-session-manager.js";

const usageReport = {
  service: "tavily",
  fetchedAt: 1_700_000_000_000,
  accuracy: "official",
  supported: true,
  entries: [
    { scope: "credential", used: 150, limit: 1000, unit: "credits" },
    { scope: "account", used: 500, limit: 5000, unit: "credits" },
  ],
};

function harness(declared: Array<"search" | "extract" | "usage">) {
  const executed: Array<string> = [];
  const providers = {
    getDefinition: () => ({ id: "tavily", config: { type: "tavily", enabled: true } }),
  } as unknown as ProviderRegistry;
  const runtimes = {
    select: () => ({
      id: "runner-1",
      status: "online",
      capabilities: {
        providerTypes: ["tavily"],
        providerIds: ["tavily"],
        browsers: [],
        profiles: [],
        http: true,
        browserAutomation: false,
        providerOperations: { tavily: declared },
      },
    }),
  } as unknown as RuntimeRegistry;
  const sessions = {
    execute: async (_id: string, request: { operation: string }) => {
      executed.push(request.operation);
      return { runtimeId: "runner-1", output: usageReport };
    },
  } as unknown as RunnerSessionManager;
  return { dispatcher: new ExecutionDispatcher(providers, runtimes, sessions), executed };
}

describe("usage dispatch", () => {
  it("dispatches usage when the runner declares the capability", async () => {
    const { dispatcher, executed } = harness(["search", "extract", "usage"]);

    const result = await dispatcher.usage("tavily");

    expect(result.runtimeId).toBe("runner-1");
    expect(result.output).toEqual(usageReport);
    expect(executed).toEqual(["usage"]);
  });

  it("refuses usage on runners that do not declare it", async () => {
    const { dispatcher, executed } = harness(["search", "extract"]);

    await expect(dispatcher.usage("tavily")).rejects.toMatchObject({ code: "NO_COMPATIBLE_RUNTIME" });
    expect(executed).toEqual([]);
  });
});

describe("POST /v1/providers/:providerId/usage", () => {
  it("requires authentication", async () => {
    const { app } = createAdminTestServer({ providers: { tavily: { type: "tavily" } } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers/tavily/usage",
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns the provider usage report", async () => {
    const server = createAdminTestServer({ providers: { tavily: { type: "tavily" } } });
    (server.context.dispatcher as unknown as { usage: unknown }).usage = async () => ({
      runtimeId: "runner-1",
      output: usageReport,
    });

    const response = await server.app.inject({
      method: "POST",
      url: "/v1/providers/tavily/usage",
      headers: { authorization: "Bearer admin-test-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { providerId: string; runtimeId: string; usage: typeof usageReport };
    expect(body.providerId).toBe("tavily");
    expect(body.runtimeId).toBe("runner-1");
    expect(body.usage.entries[0]).toMatchObject({ scope: "credential", unit: "credits" });
  });

  it("reports a provider that does not support usage as an unavailable capability", async () => {
    const server = createAdminTestServer({ providers: { urlfetch: { type: "url-fetch" } } });
    (server.context.dispatcher as unknown as { usage: unknown }).usage = async () => {
      // 与 dispatcher 抛出的真实类型一致：普通 Error 不会被错误处理器映射成 503。
      throw new RetrievalError(
        "NO_COMPATIBLE_RUNTIME",
        "Runtime does not support usage for provider: urlfetch",
        { retryable: false },
      );
    };

    const response = await server.app.inject({
      method: "POST",
      url: "/v1/providers/urlfetch/usage",
      headers: { authorization: "Bearer admin-test-key" },
    });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe("NO_COMPATIBLE_RUNTIME");
  });
});
