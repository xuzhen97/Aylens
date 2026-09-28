import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { providerSchema } from "../src/config/schema.js";
import { RunnerSessionManager } from "../src/runtime/runner-session-manager.js";
import type { RuntimeExecutionRequest } from "../src/runtime/types.js";

function createSocket() {
  const sent: string[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => sent.push(raw),
    close: vi.fn(),
  } as unknown as WebSocket;

  return { socket, sent };
}

function searchRequest(executionId: string): RuntimeExecutionRequest {
  return {
    jobId: "job-1",
    executionId,
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
  };
}

function jobPhaseMessage(
  type: "JOB_ACCEPTED" | "JOB_STARTED",
  executionId: string,
): Parameters<RunnerSessionManager["handle"]>[0] {
  return {
    type,
    messageId: "message-1",
    runnerId: "runner-1",
    jobId: "job-1",
    executionId,
    timestamp: Date.now(),
  };
}

describe("RunnerSessionManager", () => {
  it("preserves known structured error codes returned by a Runner", async () => {
    const { socket } = createSocket();
    const manager = new RunnerSessionManager(1000);
    manager.attach("runner-1", socket);

    const execution = manager.execute("runner-1", searchRequest("exec-1"));

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

  it("does not settle a job on the Runner's progress announcements", async () => {
    const { socket } = createSocket();
    const manager = new RunnerSessionManager(1000);
    manager.attach("runner-1", socket);

    const execution = manager.execute("runner-1", searchRequest("exec-progress"));

    manager.handle(jobPhaseMessage("JOB_ACCEPTED", "exec-progress"));
    manager.handle(jobPhaseMessage("JOB_STARTED", "exec-progress"));

    manager.handle({
      type: "JOB_RESULT",
      messageId: "message-2",
      runnerId: "runner-1",
      jobId: "job-1",
      executionId: "exec-progress",
      output: { items: [] },
      timestamp: Date.now(),
    });

    // Had either announcement settled the job, this would already be rejected
    // and `handle` would have dropped the result instead of resolving it.
    await expect(execution).resolves.toMatchObject({ runtimeId: "runner-1" });
  });

  it("cancels a timed-out job and reports how far it got", async () => {
    const { socket, sent } = createSocket();
    const manager = new RunnerSessionManager(30);
    manager.attach("runner-1", socket);

    const execution = manager.execute("runner-1", searchRequest("exec-started"));
    manager.handle(jobPhaseMessage("JOB_STARTED", "exec-started"));

    await expect(execution).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      details: { phase: "started" },
    });

    const cancel = sent
      .map((raw) => JSON.parse(raw) as { type: string; executionId?: string })
      .find((message) => message.type === "CANCEL");

    // Nothing used to send CANCEL, so a timed-out job kept running on the Runner
    // and held its browser profile lease.
    expect(cancel).toMatchObject({ executionId: "exec-started" });
  });

  it("says a job was never acknowledged when the Runner stayed silent", async () => {
    const { socket } = createSocket();
    const manager = new RunnerSessionManager(20);
    manager.attach("runner-1", socket);

    await expect(
      manager.execute("runner-1", searchRequest("exec-silent")),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      details: { phase: "queued" },
    });
  });
});
