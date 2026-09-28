import type WebSocket from "ws";
import { isRetrievalErrorCode, RetrievalError } from "../core/errors.js";
import { createId } from "../shared/ids.js";
import { providerSearchResponseSchema } from "../contracts/validation.js";
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from "./types.js";
import type { RunnerToGatewayMessage } from "./protocol.js";

interface PendingJob {
  resolve: (value: RuntimeExecutionResult) => void;
  reject: (reason: unknown) => void;
  timer?: NodeJS.Timeout | undefined;
  runtimeId: string;
  /** Mirrors the Runner's own job lifecycle, so a timeout can say how far it got. */
  accepted: boolean;
  started: boolean;
}

function jobPhase(job: PendingJob): "queued" | "accepted" | "started" {
  if (job.started) return "started";
  if (job.accepted) return "accepted";
  return "queued";
}

function describePhase(job: PendingJob): string {
  if (job.started) return "the Runner started it but never finished";
  if (job.accepted) return "the Runner accepted it but never started it";
  return "the Runner never acknowledged it";
}

export class RunnerSessionManager {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingJob>();

  constructor(private readonly jobTimeoutMs: number) {}

  isCurrent(runtimeId: string, socket: WebSocket): boolean {
    return this.sockets.get(runtimeId) === socket;
  }

  /** True when a socket for this Runner is attached and still open. */
  isAttached(runtimeId: string): boolean {
    const socket = this.sockets.get(runtimeId);
    return socket !== undefined && socket.readyState === socket.OPEN;
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
    // Only job-scoped messages carry an executionId.
    if (message.type === "REGISTER" || message.type === "HEARTBEAT") return;

    const pending = this.pending.get(message.executionId);
    if (!pending) return;

    // The Runner announces both phases. Recording them does not settle the job;
    // it only makes a later timeout say whether the work ever began.
    if (message.type === "JOB_ACCEPTED") {
      pending.accepted = true;
      return;
    }

    if (message.type === "JOB_STARTED") {
      pending.started = true;
      return;
    }

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

  /**
   * Tells the Runner to stop working on a job the Gateway has given up on.
   *
   * CANCEL has been in the protocol from the start but nothing ever sent it, so
   * a timed-out job kept running on the Runner and held its browser profile
   * lease — the next job then queued behind work nobody was waiting for.
   */
  private cancel(socket: WebSocket, request: RuntimeExecutionRequest): void {
    if (socket.readyState !== socket.OPEN) return;

    socket.send(JSON.stringify({
      type: "CANCEL",
      messageId: createId("msg"),
      jobId: request.jobId,
      executionId: request.executionId,
      timestamp: Date.now(),
    }));
  }

  execute(runtimeId: string, request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const socket = this.sockets.get(runtimeId);
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new RetrievalError("RUNTIME_OFFLINE", `Runtime is not connected: ${runtimeId}`, { retryable: true });
    }

    return new Promise((resolve, reject) => {
      const pending: PendingJob = {
        resolve,
        reject,
        runtimeId,
        accepted: false,
        started: false,
      };

      pending.timer = setTimeout(() => {
        this.pending.delete(request.executionId);
        this.cancel(socket, request);
        reject(
          new RetrievalError(
            "TIMEOUT",
            `Remote execution timed out after ${this.jobTimeoutMs}ms (${describePhase(pending)})`,
            { retryable: true, details: { phase: jobPhase(pending) } },
          ),
        );
      }, this.jobTimeoutMs);

      this.pending.set(request.executionId, pending);

      socket.send(JSON.stringify({
        type: "EXECUTE",
        messageId: createId("msg"),
        jobId: request.jobId,
        executionId: request.executionId,
        providerId: request.providerId,
        providerType: request.providerType,
        operation: request.operation,
        input: request.input,
        requestId: request.requestId,
        traceId: request.traceId,
        timestamp: Date.now(),
      }));
    });
  }
}
