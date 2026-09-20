import type WebSocket from "ws";
import { isRetrievalErrorCode, RetrievalError } from "../core/errors.js";
import { createId } from "../shared/ids.js";
import { providerSearchResponseSchema } from "../contracts/validation.js";
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from "./types.js";
import type { RunnerToGatewayMessage } from "./protocol.js";

interface PendingJob {
  resolve: (value: RuntimeExecutionResult) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  runtimeId: string;
}

export class RunnerSessionManager {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingJob>();

  constructor(private readonly jobTimeoutMs: number) {}

  isCurrent(runtimeId: string, socket: WebSocket): boolean {
    return this.sockets.get(runtimeId) === socket;
  }

  attach(runtimeId: string, socket: WebSocket): void {
    const previous = this.sockets.get(runtimeId);
    this.sockets.set(runtimeId, socket);

    if (previous && previous !== socket) {
      this.rejectPending(runtimeId, "Runner session was replaced");
      previous.close(1012, "runner session replaced");
    }
  }

  detach(runtimeId: string, socket?: WebSocket): boolean {
    const current = this.sockets.get(runtimeId);
    if (!current || (socket && current !== socket)) return false;

    this.sockets.delete(runtimeId);
    this.rejectPending(runtimeId, `Runner disconnected: ${runtimeId}`);
    return true;
  }

  private rejectPending(runtimeId: string, message: string): void {
    for (const [executionId, job] of this.pending) {
      if (job.runtimeId !== runtimeId) continue;
      clearTimeout(job.timer);
      job.reject(new RetrievalError("RUNNER_LOST", message, { retryable: true }));
      this.pending.delete(executionId);
    }
  }

  handle(message: RunnerToGatewayMessage): void {
    if (message.type !== "JOB_RESULT" && message.type !== "JOB_ERROR") return;
    const pending = this.pending.get(message.executionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.executionId);

    if (message.type === "JOB_ERROR") {
      const code = isRetrievalErrorCode(message.error.code)
        ? message.error.code
        : "PROVIDER_UNAVAILABLE";

      pending.reject(
        new RetrievalError(code, message.error.message, {
          retryable: message.error.retryable,
          details: { runnerCode: message.error.code },
        }),
      );
      return;
    }

    const output = providerSearchResponseSchema.safeParse(message.output);
    if (!output.success) {
      pending.reject(
        new RetrievalError("PROVIDER_UNAVAILABLE", "Runner returned an invalid provider response", {
          details: { issues: output.error.issues },
        }),
      );
      return;
    }

    pending.resolve({
      runtimeId: message.runnerId,
      output: output.data,
    });
  }

  execute(runtimeId: string, request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const socket = this.sockets.get(runtimeId);
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new RetrievalError("RUNTIME_OFFLINE", `Runtime is not connected: ${runtimeId}`, { retryable: true });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.executionId);
        reject(new RetrievalError("TIMEOUT", `Remote execution timed out: ${request.executionId}`, { retryable: true }));
      }, this.jobTimeoutMs);

      this.pending.set(request.executionId, { resolve, reject, timer, runtimeId });

      socket.send(JSON.stringify({
        type: "EXECUTE",
        messageId: createId("msg"),
        jobId: request.jobId,
        executionId: request.executionId,
        providerId: request.providerId,
        providerType: request.providerType,
        providerConfig: request.providerConfig,
        operation: request.operation,
        input: request.input,
        requestId: request.requestId,
        traceId: request.traceId,
        timestamp: Date.now(),
      }));
    });
  }
}
