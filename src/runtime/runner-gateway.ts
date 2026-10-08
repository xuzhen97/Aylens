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
import { upgradeIsSecureOrLocal } from "../api/http/config-channel-security.js";
import type { RunnerConfigChannel } from "./runner-config-channel.js";

function safeTokenEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function attachRunnerGateway(options: {
  app: FastifyInstance;
  path: string;
  tokens: Record<string, string>;
  /**
   * Runner 最长允许多久不发送心跳;超过该时间后,新连接可以接管相同 ID。   * 这样可以避免异常崩溃且未关闭 Socket 的 Runner 永久阻止替代实例上线。
   */
  heartbeatTimeoutMs: number;
  runtimes: RuntimeRegistry;
  sessions: RunnerSessionManager;
  /**
   * 配置通道是必备依赖而非可选能力:Runner 注册与心跳都必须在此登记 socket,
   * 否则 `/admin/proxies` 的读取请求永远命中不了任何会话(表现为 RUNTIME_OFFLINE)。
   * 「Runner 侧不支持代理配置」是另一种事实,由 capabilities.proxyConfig 上报,
   * 在 request() 时按 CONFIG_UNSUPPORTED 拒絶——那不是缺少通道。
   */
  configChannel: RunnerConfigChannel;
  trustedProxies?: readonly string[];
}): WebSocketServer {
  const wss = new WebSocketServer({ server: options.app.server, path: options.path });

  wss.on("connection", (socket, request) => {
    const authorization = request.headers.authorization ?? "";
    const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    // 配置通道的安全判定:按实际 TCP/TLS 与可信代理判断,不接受 Runner 自报。
    const secureOrLocal = upgradeIsSecureOrLocal({
      socketRemoteAddress: request.socket.remoteAddress,
      headers: request.headers,
      // SAFETY: ws 在 TLS socket 上提供 encrypted 布尔属性,但 @types/node 的 net.Socket 类型未声明;
    // 这里只读该属性判断是否为 TLS 直连,不做任何写入。
    isTls: (request.socket as unknown as { encrypted?: boolean }).encrypted === true,
    }, options.trustedProxies ?? []);

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

        // 两个存活进程若声明同一 ID，会在重连时不断互相替换；因此拒绝后来者，除非原连接已经停止心跳。
        const incumbent = options.runtimes.get(message.runnerId);
        const incumbentIsFresh =
          incumbent !== undefined &&
          Date.now() - incumbent.lastSeenAt <= options.heartbeatTimeoutMs;

        if (incumbentIsFresh && options.sessions.isAttached(message.runnerId)) {
          socket.close(1013, `runner id already connected: ${message.runnerId}`);
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
        options.configChannel.attach(message.runnerId, socket, {
          secureOrLocal,
          supportsProxyConfig: message.capabilities.proxyConfig === true,
        });

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
        // 心跳同时刷新能力声明:同一 socket 下attach 只覆盖 metadata,不重建会话。
        options.configChannel.attach(runnerId, socket, {
          secureOrLocal,
          supportsProxyConfig: message.capabilities.proxyConfig === true,
        });
        return;
      }

      if (message.type === "CONFIG_RESULT" || message.type === "CONFIG_ERROR") {
        options.configChannel.handle(message);
        return;
      }

      options.sessions.handle(message);
    });

    socket.on("close", () => {
      if (!runnerId) return;
      const detached = options.sessions.detach(runnerId, socket);
      if (detached) options.runtimes.markOffline(runnerId);
      options.configChannel.detach(runnerId, socket);
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
