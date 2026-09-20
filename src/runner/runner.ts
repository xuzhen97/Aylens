import { hostname, platform } from "node:os";
import WebSocket from "ws";
import type { RunnerConfig } from "./config.js";
import type { RunnerRuntime } from "./runtime.js";
import { createId } from "../shared/ids.js";
import { toErrorPayload } from "../core/errors.js";
import { providerSchema } from "../config/schema.js";
import { searchRequestSchema } from "../contracts/validation.js";
import {
  gatewayToRunnerSchema,
  RUNNER_PROTOCOL_VERSION,
} from "../runtime/protocol.js";

function normalizeOs(value: NodeJS.Platform): "windows" | "linux" | "darwin" {
  if (value === "win32") return "windows";
  if (value === "darwin") return "darwin";
  return "linux";
}

export class AylensRunner {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private activeJobs = 0;

  constructor(
    private readonly config: RunnerConfig,
    private readonly runtime: RunnerRuntime,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.runner.gatewayUrl, {
        headers: { authorization: `Bearer ${this.config.runner.token}` },
      });
      this.socket = socket;

      socket.once("error", reject);

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
          socket.removeListener("error", reject);
          this.startHeartbeat();
          resolve();
          return;
        }

        if (message.type === "EXECUTE") {
          void this.handleExecute(socket, message);
        }
      });

      socket.on("close", () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
      });
    });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(1000, "runner shutting down");
    await this.runtime.close();
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
      const providerConfig = providerSchema.parse(message.providerConfig);
      if (providerConfig.type !== message.providerType) {
        throw new Error(
          `Provider type mismatch: message=${message.providerType} config=${providerConfig.type}`,
        );
      }

      const request = searchRequestSchema.parse(message.input);
      const provider = this.runtime.providers.create(
        message.providerId,
        providerConfig,
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
      this.sendJobError(socket, message, toErrorPayload(error));
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
