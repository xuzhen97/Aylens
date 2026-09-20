import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import WebSocket, { WebSocketServer } from "ws";
import { createId } from "../shared/ids.js";
import {
  RUNNER_PROTOCOL_VERSION,
  runnerToGatewaySchema,
  type RunnerToGatewayMessage,
} from "./protocol.js";
import type { RuntimeRegistry } from "./registry.js";
import type { RunnerSessionManager } from "./runner-session-manager.js";

function safeTokenEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function attachRunnerGateway(options: {
  app: FastifyInstance;
  path: string;
  tokens: Record<string, string>;
  runtimes: RuntimeRegistry;
  sessions: RunnerSessionManager;
}): WebSocketServer {
  const wss = new WebSocketServer({ server: options.app.server, path: options.path });

  wss.on("connection", (socket, request) => {
    const authorization = request.headers.authorization ?? "";
    const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

    let runnerId: string | undefined;

    socket.on("message", (raw) => {
      let message: RunnerToGatewayMessage;
      try {
        message = runnerToGatewaySchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.close(1003, "invalid message");
        return;
      }

      if (message.type === "REGISTER") {
        const expectedToken = options.tokens[message.runnerId];
        if (!expectedToken || !safeTokenEqual(expectedToken, suppliedToken)) {
          socket.close(1008, "unauthorized runner");
          return;
        }
        if (message.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
          socket.close(1002, "protocol version mismatch");
          return;
        }

        runnerId = message.runnerId;
        options.runtimes.upsert({
          id: message.runnerId,
          hostname: message.hostname,
          os: message.os,
          version: message.version,
          protocolVersion: message.protocolVersion,
          status: "online",
          labels: message.labels,
          capabilities: message.capabilities,
          capacity: message.capacity,
          lastSeenAt: Date.now(),
        });
        options.sessions.attach(message.runnerId, socket);

        socket.send(JSON.stringify({
          type: "REGISTERED",
          messageId: createId("msg"),
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          timestamp: Date.now(),
        }));
        return;
      }

      if (!runnerId || message.runnerId !== runnerId) {
        socket.close(1008, "runner not registered");
        return;
      }

      if (!options.sessions.isCurrent(runnerId, socket)) {
        socket.close(1008, "stale runner session");
        return;
      }

      if (message.type === "HEARTBEAT") {
        options.runtimes.heartbeat(runnerId, {
          capabilities: message.capabilities,
          capacity: message.capacity,
          lastSeenAt: Date.now(),
        });
        return;
      }

      options.sessions.handle(message);
    });

    socket.on("close", () => {
      if (!runnerId) return;
      const detached = options.sessions.detach(runnerId, socket);
      if (detached) options.runtimes.markOffline(runnerId);
    });

    socket.on("error", () => {
      if (runnerId) options.runtimes.markOffline(runnerId);
    });
  });

  options.app.addHook("onClose", async () => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.close(1001, "gateway shutting down");
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  return wss;
}
