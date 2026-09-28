import { hostname, platform } from "node:os";
import WebSocket from "ws";
import type { RunnerConfig } from "./config.js";
import type { RunnerRuntime } from "./runtime.js";
import { createId } from "../shared/ids.js";
import { toErrorPayload } from "../core/errors.js";
import { searchRequestSchema } from "../contracts/validation.js";
import {
  gatewayToRunnerSchema,
  RUNNER_PROTOCOL_VERSION,
} from "../runtime/protocol.js";

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function normalizeOs(value: NodeJS.Platform): "windows" | "linux" | "darwin" {
  if (value === "win32") return "windows";
  if (value === "darwin") return "darwin";
  return "linux";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export interface RunnerLifecycle {
  connected?(runnerId: string): void;
  disconnected?(reason: string): void;
  /** A connection attempt failed before registering; a retry is scheduled. */
  connectionFailed?(error: Error, attempt: number, retryInMs: number): void;
  /** An established connection was lost; a retry is scheduled. */
  reconnecting?(attempt: number, retryInMs: number): void;
}

export interface RunnerOptions {
  lifecycle?: RunnerLifecycle;
  /** Reconnect backoff bounds. Defaults to a 1s base with a 30s cap. */
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number };
}

export class AylensRunner {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout | undefined;
  private activeJobs = 0;
  private closing = false;
  private attempt = 0;
  private waitHandle?: { wake: () => void } | undefined;
  private disconnect: Promise<string> = Promise.resolve("not connected");
  private resolveDisconnect: (reason: string) => void = () => {};

  /** executionId -> controller, so a Gateway CANCEL can stop the real work. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly runtime: RunnerRuntime,
    private readonly options: RunnerOptions = {},
  ) {}

  /**
   * A single connection attempt. Resolves once the Gateway answers REGISTER with
   * REGISTERED.
   *
   * Rejects on any failure before that, *including a clean close*: the Gateway
   * refuses an unauthorized or protocol-mismatched Runner by closing the socket
   * with a code and never emits `error`, so waiting for `error` alone left this
   * promise pending forever — a wrong token looked like a silent hang.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disconnect = new Promise<string>((settle) => {
        this.resolveDisconnect = settle;
      });

      const socket = new WebSocket(this.config.runner.gatewayUrl, {
        headers: { authorization: `Bearer ${this.config.runner.token}` },
      });
      this.socket = socket;

      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.on("error", (error: unknown) => {
        fail(asError(error));
      });

      socket.on("open", () => {
        socket.send(JSON.stringify(this.registrationMessage()));
      });

      socket.on("message", (raw) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const parsed = gatewayToRunnerSchema.safeParse(decoded);
        if (!parsed.success) return;
        const message = parsed.data;

        if (message.type === "REGISTERED") {
          if (settled) return;
          settled = true;
          this.startHeartbeat();
          resolve();
          return;
        }

        if (message.type === "EXECUTE") {
          void this.handleExecute(socket, message);
          return;
        }

        if (message.type === "CANCEL") {
          this.cancelExecution(message.executionId);
        }
      });

      socket.on("close", (code, reason) => {
        this.stopHeartbeat();
        // In-flight results can no longer be delivered, and their provider work
        // would otherwise keep a browser profile leased for nobody.
        this.abortInFlight("Runner lost its Gateway connection");

        const text = `Gateway closed the connection (${code}${
          reason.length > 0 ? ` ${reason.toString()}` : ""
        })`;
        this.resolveDisconnect(text);

        fail(new Error(text));
      });
    });
  }

  /**
   * Connects and keeps reconnecting until `close()`.
   *
   * `ws` never retries on its own and the Gateway only notices a dead Runner
   * through a heartbeat timeout, so without this loop every Gateway restart left
   * the Runner silently alive but unreachable.
   */
  async serve(): Promise<void> {
    while (!this.closing) {
      try {
        await this.connect();
      } catch (error) {
        if (this.closing) return;
        this.attempt += 1;
        const retryInMs = this.backoffMs(this.attempt);
        this.options.lifecycle?.connectionFailed?.(asError(error), this.attempt, retryInMs);
        await this.wait(retryInMs);
        continue;
      }

      this.attempt = 0;
      this.options.lifecycle?.connected?.(this.config.runner.id);

      const reason = await this.disconnect;
      if (this.closing) return;

      this.options.lifecycle?.disconnected?.(reason);
      this.attempt += 1;
      const retryInMs = this.backoffMs(this.attempt);
      this.options.lifecycle?.reconnecting?.(this.attempt, retryInMs);
      await this.wait(retryInMs);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.waitHandle?.wake();
    this.waitHandle = undefined;
    this.stopHeartbeat();
    this.abortInFlight("Runner is shutting down");
    this.socket?.close(1000, "runner shutting down");
    await this.runtime.close();
  }

  private backoffMs(attempt: number): number {
    const base = this.options.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
    const max = this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
    const ceiling = Math.min(max, base * 2 ** (attempt - 1));
    // Half fixed, half random: keeps a fleet of Runners from returning in lockstep.
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waitHandle = undefined;
        resolve();
      }, ms);

      this.waitHandle = {
        wake: () => {
          clearTimeout(timer);
          this.waitHandle = undefined;
          resolve();
        },
      };
    });
  }

  private cancelExecution(executionId: string): void {
    const controller = this.inFlight.get(executionId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error("Cancelled by the Gateway"));
    }
  }

  private abortInFlight(reason: string): void {
    for (const controller of this.inFlight.values()) {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    }
    this.inFlight.clear();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async handleExecute(
    socket: WebSocket,
    message: Extract<ReturnType<typeof gatewayToRunnerSchema.parse>, { type: "EXECUTE" }>,
  ): Promise<void> {
    if (this.activeJobs >= this.config.runner.maxJobs) {
      this.sendJobError(socket, message, {
        code: "RATE_LIMITED",
        message: "Runner is at capacity",
        retryable: true,
      });
      return;
    }

    this.activeJobs += 1;
    const controller = new AbortController();
    this.inFlight.set(message.executionId, controller);

    let released = false;
    const releaseCapacity = () => {
      if (released) return;
      released = true;
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      this.sendHeartbeat(socket);
    };

    socket.send(JSON.stringify({
      type: "JOB_ACCEPTED",
      messageId: createId("msg"),
      runnerId: this.config.runner.id,
      jobId: message.jobId,
      executionId: message.executionId,
      timestamp: Date.now(),
    }));

    socket.send(JSON.stringify({
      type: "JOB_STARTED",
      messageId: createId("msg"),
      runnerId: this.config.runner.id,
      jobId: message.jobId,
      executionId: message.executionId,
      timestamp: Date.now(),
    }));

    try {
      const deployment = this.runtime.deployments[message.providerId];
      if (!deployment) {
        throw new Error(`Provider deployment is not configured on this Runner: ${message.providerId}`);
      }
      if (deployment.type !== message.providerType) {
        throw new Error(
          `Provider type mismatch: message=${message.providerType} deployment=${deployment.type}`,
        );
      }

      const request = searchRequestSchema.parse(message.input);
      const provider = this.runtime.providers.create(
        message.providerId,
        deployment,
        {
          transports: this.runtime.transports,
          browser: this.runtime.browser,
        },
      );

      const output = await provider.search(
        {
          requestId: message.requestId,
          traceId: message.traceId,
          runtimeId: this.config.runner.id,
          jobId: message.jobId,
          signal: controller.signal,
        },
        request,
      );

      // HEARTBEAT is intentionally sent first. WebSocket message ordering
      // guarantees the Gateway observes the released capacity before JOB_RESULT
      // resolves the caller and allows an immediate follow-up dispatch.
      releaseCapacity();

      socket.send(JSON.stringify({
        type: "JOB_RESULT",
        messageId: createId("msg"),
        runnerId: this.config.runner.id,
        jobId: message.jobId,
        executionId: message.executionId,
        output,
        timestamp: Date.now(),
      }));
    } catch (error) {
      releaseCapacity();
      this.sendJobError(
        socket,
        message,
        controller.signal.aborted
          ? {
              // The Gateway has already dropped this job, so it ignores the
              // reply; TIMEOUT is simply the closest code in the shared enum.
              code: "TIMEOUT",
              message: "Job was cancelled before it completed",
              retryable: true,
            }
          : toErrorPayload(error),
      );
    } finally {
      this.inFlight.delete(message.executionId);
    }
  }

  private sendJobError(
    socket: WebSocket,
    message: { jobId: string; executionId: string },
    error: { code: string; message: string; retryable: boolean },
  ): void {
    socket.send(JSON.stringify({
      type: "JOB_ERROR",
      messageId: createId("msg"),
      runnerId: this.config.runner.id,
      jobId: message.jobId,
      executionId: message.executionId,
      error,
      timestamp: Date.now(),
    }));
  }

  private registrationMessage() {
    return {
      type: "REGISTER",
      messageId: createId("msg"),
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerId: this.config.runner.id,
      hostname: hostname(),
      os: normalizeOs(platform()),
      version: "0.1.0",
      labels: this.config.runner.labels,
      capabilities: this.capabilities(),
      capacity: { maxJobs: this.config.runner.maxJobs, activeJobs: this.activeJobs },
      timestamp: Date.now(),
    } as const;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.sendHeartbeat(this.socket);
    }, this.config.runner.heartbeatMs);
    this.heartbeat.unref();
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
      type: "HEARTBEAT",
      messageId: createId("msg"),
      runnerId: this.config.runner.id,
      capabilities: this.capabilities(),
      capacity: {
        maxJobs: this.config.runner.maxJobs,
        activeJobs: this.activeJobs,
      },
      timestamp: Date.now(),
    }));
  }

  private capabilities() {
    return {
      providerTypes: this.runtime.pluginTypes,
      providerIds: Object.keys(this.runtime.deployments),
      browsers: [
        ...new Set([
          ...this.config.capabilities.browsers,
          ...this.runtime.profiles.list().map((profile) => profile.browser),
        ]),
      ],
      profiles: this.runtime.profiles.list().map((profile) => profile.id),
      http: this.config.capabilities.http,
      browserAutomation:
        this.config.capabilities.browserAutomation ||
        this.runtime.profiles.list().length > 0,
    };
  }
}
