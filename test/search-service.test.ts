import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import type { ProviderFactory } from "../src/providers/types.js";
import { RetrievalError } from "../src/core/errors.js";

const base = {
  version: 1 as const,
  server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
  auth: { apiKey: "api", runnerTokens: {} },
  runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 2000, jobTimeoutMs: 1000 },
  transports: { direct: { type: "direct" as const } },
  browserProfiles: {},
};

describe("SearchService", () => {
  it("returns an empty completed result when the route has no providers", async () => {
    const config = appConfigSchema.parse({
      ...base,
      providers: {},
      routes: { default: { providers: [] } },
    });
    const context = createGatewayContext(config);

    const response = await context.search.search({ query: "hello" });

    expect(response.status).toBe("completed");
    expect(response.items).toEqual([]);
    expect(context.audit.get(response.requestId)?.status).toBe("completed");
  });

  it("can add a local provider through the factory registry without changing SearchService", async () => {
    const config = appConfigSchema.parse({
      ...base,
      providers: {
        fake: { type: "fake", enabled: true, runtime: { mode: "local" }, options: {} },
      },
      routes: { default: { providers: ["fake"] } },
    });
    const context = createGatewayContext(config);

    const factory: ProviderFactory = {
      type: "fake",
      create: (id) => ({
        id,
        search: async (providerContext) => ({
          items: [{
            id: "doc-1",
            platform: "test",
            type: "webpage",
            url: "https://example.test",
            retrievedAt: new Date().toISOString(),
            provenance: {
              provider: id,
              retrievalMethod: "test",
              requestId: providerContext.requestId,
              fetchedAt: new Date().toISOString(),
              runtimeId: providerContext.runtimeId,
            },
          }],
        }),
      }),
    };

    context.providers.registerFactory(factory);
    const response = await context.search.search({ query: "hello" });

    expect(response.status).toBe("completed");
    expect(response.items).toHaveLength(1);
    expect(response.meta.providers.fake?.runtimeId).toBe("local");
  });

  it("returns provider error details and the selected runtime when execution fails", async () => {
    const config = appConfigSchema.parse({
      ...base,
      providers: {
        failing: { type: "failing", enabled: true, runtime: { mode: "local" }, options: {} },
      },
      routes: { default: { providers: ["failing"] } },
    });
    const context = createGatewayContext(config);

    const factory: ProviderFactory = {
      type: "failing",
      create: (id) => ({
        id,
        search: async () => {
          throw new RetrievalError("CONTENT_UNAVAILABLE", "Fixture content could not be read", {
            retryable: true,
          });
        },
      }),
    };

    context.providers.registerFactory(factory);
    const response = await context.search.search({ query: "https://example.test/failure" });

    expect(response.status).toBe("failed");
    expect(response.items).toEqual([]);
    expect(response.meta.providers.failing).toMatchObject({
      status: "failed",
      runtimeId: "local",
      resultCount: 0,
      error: {
        code: "CONTENT_UNAVAILABLE",
        message: "Fixture content could not be read",
        retryable: true,
      },
    });
    expect(context.audit.get(response.requestId)?.providers[0]).toMatchObject({
      providerId: "failing",
      runtimeId: "local",
      status: "failed",
      errorCode: "CONTENT_UNAVAILABLE",
    });
  });
});
