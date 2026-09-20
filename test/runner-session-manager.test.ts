import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { providerSchema } from "../src/config/schema.js";
import { RunnerSessionManager } from "../src/runtime/runner-session-manager.js";

describe("RunnerSessionManager", () => {
  it("preserves known structured error codes returned by a Runner", async () => {
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    const manager = new RunnerSessionManager(1000);
    manager.attach("runner-1", socket);

    const execution = manager.execute("runner-1", {
      jobId: "job-1",
      executionId: "exec-1",
      providerId: "provider-1",
      providerType: "fake",
      providerConfig: providerSchema.parse({
        type: "fake",
        enabled: true,
        runtime: { nodeId: "runner-1" },
        options: {},
      }),
      operation: "search",
      input: { query: "hello" },
      requestId: "request-1",
      traceId: "trace-1",
    });

    manager.handle({
      type: "JOB_ERROR",
      messageId: "message-1",
      runnerId: "runner-1",
      jobId: "job-1",
      executionId: "exec-1",
      error: {
        code: "PROXY_FAILED",
        message: "proxy unavailable",
        retryable: true,
      },
      timestamp: Date.now(),
    });

    await expect(execution).rejects.toMatchObject({
      code: "PROXY_FAILED",
      retryable: true,
    });
  });
});
