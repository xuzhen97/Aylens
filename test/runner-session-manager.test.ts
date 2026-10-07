import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSearchResponse } from "../src/contracts/search.js";
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
  it("preserves the optional markdown field across Runner output validation", async () => {
    const { socket } = createSocket();
    const manager = new RunnerSessionManager(1000);
    manager.attach("runner-1", socket);

    const execution = manager.execute<ProviderSearchResponse>("runner-1", searchRequest("exec-markdown"));
    const provenance = {
      provider: "provider-1",
      retrievalMethod: "http",
      requestId: "request-1",
      fetchedAt: new Date().toISOString(),
    };

    manager.handle({
      type: "JOB_RESULT",
      messageId: "message-markdown",
      runnerId: "runner-1",
      jobId: "job-1",
      executionId: "exec-markdown",
      output: {
        items: [
          {
            id: "doc-1",
            platform: "web",
            type: "webpage",
            url: "https://example.test/",
            markdown: "# Title\n\nBody",
            retrievedAt: new Date().toISOString(),
            provenance,
          },
          {
            id: "doc-2",
            platform: "web",
            type: "webpage",
            url: "https://example.test/plain",
            retrievedAt: new Date().toISOString(),
            provenance,
          },
        ],
      },
      timestamp: Date.now(),
    });

    // Zod 默认会剥离未声明字段；markdown 必须是显式契约的一部分，否则会静默丢失。
    const result = await execution;
    expect(result.output.items[0]?.markdown).toBe("# Title\n\nBody");
    expect(result.output.items[1]?.markdown).toBeUndefined();
  });

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

    // JOB_ACCEPTED/JOB_STARTED 只更新阶段，不能结束任务；否则真正结果到达时会被当作无效消息丢弃。
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

    // Gateway 超时后必须发送 CANCEL，否则 Runner 会继续执行并占用 Browser Profile Lease。
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
