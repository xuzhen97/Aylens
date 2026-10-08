import { z } from "zod";
import { safeProxyConfigSchema } from "./proxy-config-contract.js";
import { createId } from "../shared/ids.js";
import { RetrievalError, isRetrievalErrorCode, type RetrievalErrorCode } from "../core/errors.js";
import type { ProxyWrite, SafeProxyConfig } from "./proxy-config-contract.js";
import type WebSocket from "ws";

export const CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PENDING_PER_RUNNER = 32;

/** Gateway → Runner 的独立配置请求;write 携带 operationId 与期望版本。 */
export interface ConfigRequestPayload {
  kind: "read" | "write";
  write?: ProxyWrite;
}

export const configResultMessageSchema = z.object({
  type: z.literal("CONFIG_RESULT"),
  messageId: z.string(),
  requestId: z.string(),
  runnerId: z.string(),
  result: safeProxyConfigSchema,
  timestamp: z.number(),
});

export const configErrorMessageSchema = z.object({
  type: z.literal("CONFIG_ERROR"),
  messageId: z.string(),
  requestId: z.string(),
  runnerId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  timestamp: z.number(),
});

export const configReplySchema = z.discriminatedUnion("type", [
  configResultMessageSchema,
  configErrorMessageSchema,
]);

export type ConfigReplyMessage = z.infer<typeof configReplySchema>;

interface PendingEntry {
  resolve: (value: SafeProxyConfig) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  runtimeId: string;
  /** 已发送 write 的请求,任何连接/超时失败都只能报告“结果待确认”。 */
  isWrite: boolean;
}

interface AttachedSocket {
  socket: WebSocket;
  secureOrLocal: boolean;
  supportsProxyConfig: boolean;
}

/**
 * Gateway 侧配置通道:请求关联、超时与会话清理。
 * 只在 pending 中保留转发所需状态,不保留 write 原文。
 */
export class RunnerConfigChannel {
  private readonly attached = new Map<string, AttachedSocket>();
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly timeoutMs = CONFIG_REQUEST_TIMEOUT_MS) {}

  attach(runtimeId: string, socket: WebSocket, metadata: { secureOrLocal: boolean; supportsProxyConfig?: boolean }): void {
    const previous = this.attached.get(runtimeId);
    if (previous && previous.socket !== socket) {
      this.failPending(runtimeId, "CONFIG_RESULT_UNKNOWN", "Runner session was replaced");
      // 测试桩可能没有 close;真实 WebSocket 断开由 Gateway 会话层处理,这里尽力而为。
      if (typeof (previous.socket as { close?: unknown }).close === "function") {
        previous.socket.close(1012, "runner session replaced");
      }
    }
    this.attached.set(runtimeId, {
      socket,
      secureOrLocal: metadata.secureOrLocal,
      supportsProxyConfig: metadata.supportsProxyConfig ?? false,
    });
  }

  detach(runtimeId: string, socket: WebSocket): void {
    const current = this.attached.get(runtimeId);
    if (!current || current.socket !== socket) return;
    this.attached.delete(runtimeId);
    this.failPending(runtimeId, "CONFIG_RESULT_UNKNOWN", "Runner connection was lost");
  }

  async request(runtimeId: string, payload: ConfigRequestPayload): Promise<SafeProxyConfig> {
    const attached = this.attached.get(runtimeId);
    if (!attached || attached.socket.readyState !== attached.socket.OPEN) {
      throw new RetrievalError("RUNTIME_OFFLINE", `Runtime is not connected: ${runtimeId}`, { retryable: true });
    }
    if (!attached.secureOrLocal || !attached.supportsProxyConfig) {
      throw new RetrievalError("CONFIG_UNSUPPORTED", "Secure connection or proxy config support is required", { retryable: false });
    }

    const runnerPending = [...this.pending.values()]
      .filter((entry) => entry.runtimeId === runtimeId);
    if (runnerPending.length >= MAX_PENDING_PER_RUNNER) {
      throw new RetrievalError("RATE_LIMITED", "Too many pending config requests", { retryable: true });
    }

    const requestId = createId("cfg");
    const isWrite = payload.kind === "write";
    const message = {
      type: "CONFIG_REQUEST",
      messageId: createId("msg"),
      requestId,
      runnerId: runtimeId,
      kind: payload.kind,
      ...(isWrite && payload.write
        ? { write: payload.write, operationId: payload.write.operationId, expectedVersion: payload.write.expectedVersion }
        : {}),
      timestamp: Date.now(),
    };

    return new Promise<SafeProxyConfig>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RetrievalError(
          isWrite ? "CONFIG_RESULT_UNKNOWN" : "CONFIG_TIMEOUT",
          isWrite
            ? "Config write result is unknown; verify the runner state before retrying"
            : "Config request timed out",
          { retryable: false },
        ));
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer, runtimeId, isWrite });

      try {
        attached.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new RetrievalError(
          isWrite ? "CONFIG_RESULT_UNKNOWN" : "RUNNER_LOST",
          isWrite ? "Config write result is unknown; verify the runner state" : "Runner connection failed",
          { retryable: false, cause: error },
        ));
      }
    });
  }

  handle(message: unknown): void {
    const parsed = configReplySchema.safeParse(message);
    if (!parsed.success) return;

    const reply = parsed.data;
    const entry = this.pending.get(reply.requestId);
    if (!entry || entry.runtimeId !== reply.runnerId) return;

    clearTimeout(entry.timer);
    this.pending.delete(reply.requestId);

    if (reply.type === "CONFIG_RESULT") {
      entry.resolve(reply.result);
      return;
    }

    // Runner 返回的错误码必须映射到已知契约;未知码统一为 PROVIDER_UNAVAILABLE,不透传原文。
    const code = isRetrievalErrorCode(reply.error.code)
      ? reply.error.code
      : "PROVIDER_UNAVAILABLE";
    entry.reject(new RetrievalError(
      code,
      reply.error.message,
      { retryable: false },
    ));
  }

  /** 会话替换或连接断开时清理 pending;write 一律报“结果待确认”。 */
  private failPending(runtimeId: string, code: RetrievalErrorCode, message: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.runtimeId !== runtimeId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.reject(new RetrievalError(
        entry.isWrite ? "CONFIG_RESULT_UNKNOWN" : code,
        message,
        { retryable: false },
      ));
    }
  }

  close(): void {
    for (const [runtimeId] of this.attached) {
      this.failPending(runtimeId, "RUNNER_LOST", "Config channel is shutting down");
    }
    this.attached.clear();
  }
}
