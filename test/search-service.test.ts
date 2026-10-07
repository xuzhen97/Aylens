import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import type { RunnerToGatewayMessage } from "../src/runtime/protocol.js";

const RUNNER_ID = "test-runner";

const base = {
  version: 1 as const,
  server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
  auth: { apiKey: "api", runnerTokens: {} },
  runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 2000, jobTimeoutMs: 1000 },
};

/**
 * 模拟一个已连接的 Runner：注册可调度 Runtime，并用 Socket 桩响应 EXECUTE。 * 这样可以端到端验证 Gateway 控制面，而不引入任何 Gateway 本地 Provider 执行。
 */
function attachFakeRunner(
  context: ReturnType<typeof createGatewayContext>,
  respond: (message: { jobId: string; executionId: string; requestId: string }) => RunnerToGatewayMessage,
  providerTypes: string[] = ["fake"],
): void {
  context.runtimes.upsert({
    id: RUNNER_ID,
    hostname: "test-host",
    os: "windows",
    version: "1",
    protocolVersion: "1",
    status: "online",
    labels: {},
    capabilities: {
      providerTypes,
      providerIds: providerTypes,
      browsers: [],
      profiles: [],
      http: true,
      browserAutomation: false,
    },
    capacity: { maxJobs: 1, activeJobs: 0 },
    lastSeenAt: Date.now(),
  });

  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => {
      const message = JSON.parse(raw) as { jobId: string; executionId: string; requestId: string };
      context.runnerSessions.handle(respond(message));
    },
    close: () => undefined,
  };
  context.runnerSessions.attach(RUNNER_ID, socket as unknown as WebSocket);
}

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

  it("fails with an explicit no-runtime error when no Runner is connected", async () => {
    const config = appConfigSchema.parse({
      ...base,
      providers: {
        fake: { type: "fake", enabled: true, runtime: { selector: { providerType: "fake" } }, options: {} },
      },
      routes: { default: { providers: ["fake"] } },
    });
    const context = createGatewayContext(config);

    const response = await context.search.search({ query: "hello" });

    expect(response.status).toBe("failed");
    expect(response.items).toEqual([]);
    expect(response.meta.providers.fake?.error).toMatchObject({
      code: "NO_COMPATIBLE_RUNTIME",
      retryable: true,
    });
  });

  it("executes a provider through a connected Runner", async () => {
    const config = appConfigSchema.parse({
      ...base,
      providers: {
        fake: { type: "fake", enabled: true, runtime: { nodeId: RUNNER_ID }, options: {} },
      },
      routes: { default: { providers: ["fake"] } },
    });
    const context = createGatewayContext(config);
    attachFakeRunner(context, (message) => ({
      type: "JOB_RESULT",
      messageId: "msg-result",
      runnerId: RUNNER_ID,
      jobId: message.jobId,
      executionId: message.executionId,
      output: {
        items: [{
          id: "doc-1",
          platform: "test",
          type: "webpage",
          url: "https://example.test",
          markdown: "# Title\n\nBody",
          retrievedAt: new Date().toISOString(),
          provenance: {
            provider: "fake",
            retrievalMethod: "test",
            requestId: message.requestId,
            fetchedAt: new Date().toISOString(),
            runtimeId: RUNNER_ID,
          },
        }],
      },
      timestamp: Date.now(),
    }));

    const response = await context.search.search({ query: "hello" });

    expect(response.status).toBe("completed");
    expect(response.items).toHaveLength(1);
    // markdown 是 SearchDocument 的显式契约字段；Zod 会静默剥离未声明字段，必须端到端断言它没丢。
    expect(response.items[0]?.markdown).toBe("# Title\n\nBody");
    expect(response.meta.providers.fake?.runtimeId).toBe(RUNNER_ID);
  });

  it("returns provider error details and the selected runtime when execution fails", async () => {
    const config = appConfigSchema.parse({
      ...base,
      providers: {
        failing: { type: "failing", enabled: true, runtime: { selector: { providerType: "failing" } }, options: {} },
      },
      routes: { default: { providers: ["failing"] } },
    });
    const context = createGatewayContext(config);
    attachFakeRunner(context, (message) => ({
      type: "JOB_ERROR",
      messageId: "msg-error",
      runnerId: RUNNER_ID,
      jobId: message.jobId,
      executionId: message.executionId,
      error: {
        code: "CONTENT_UNAVAILABLE",
        message: "Fixture content could not be read",
        retryable: true,
      },
      timestamp: Date.now(),
    }), ["failing"]);

    const response = await context.search.search({ query: "https://example.test/failure" });

    expect(response.status).toBe("failed");
    expect(response.items).toEqual([]);
    expect(response.meta.providers.failing).toMatchObject({
      status: "failed",
      runtimeId: RUNNER_ID,
      resultCount: 0,
      error: {
        code: "CONTENT_UNAVAILABLE",
        message: "Fixture content could not be read",
        retryable: true,
      },
    });
    expect(context.audit.get(response.requestId)?.providers[0]).toMatchObject({
      providerId: "failing",
      runtimeId: RUNNER_ID,
      status: "failed",
      errorCode: "CONTENT_UNAVAILABLE",
    });
  });
});
