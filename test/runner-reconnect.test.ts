import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { runnerConfigSchema } from "../src/runner/config.js";
import { AylensRunner } from "../src/runner/runner.js";
import { createRunnerRuntime } from "../src/runner/runtime.js";

let runner: AylensRunner | undefined;
let server: WebSocketServer | undefined;

afterEach(async () => {
  if (runner) await runner.close();
  runner = undefined;

  if (server) {
    const closing = server;
    server = undefined;
    for (const client of closing.clients) client.terminate();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

function runnerConfig(gatewayUrl: string) {
  return runnerConfigSchema.parse({
    runner: {
      id: "reconnect-test",
      gatewayUrl,
      token: "test-token",
      heartbeatMs: 50,
      maxJobs: 1,
      labels: { purpose: "reconnect-test" },
    },
    plugins: { baseDir: process.cwd(), modules: [] },
    transports: { direct: { type: "direct" } },
    browserProfiles: {},
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function startServer(
  onRegister: (socket: ServerSocket, count: number) => void,
): Promise<{ port: number; getCount: () => number }> {
  const listening = new WebSocketServer({ port: 0 });
  server = listening;
  await new Promise<void>((resolve) => listening.once("listening", resolve));

  let registrations = 0;

  listening.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string };
      if (message.type !== "REGISTER") return;

      registrations += 1;
      socket.send(JSON.stringify({
        type: "REGISTERED",
        messageId: `msg-${registrations}`,
        protocolVersion: "1",
        timestamp: Date.now(),
      }));

      onRegister(socket, registrations);
    });
  });

  return {
    port: (listening.address() as AddressInfo).port,
    getCount: () => registrations,
  };
}

describe("AylensRunner reconnect", () => {
  it("registers again after the Gateway drops the connection", async () => {
    // Gateway 重启会关闭连接，而 ws 不会自动重连；Runner 必须自行恢复连接，避免存活但永久不可达。
    const { port, getCount } = await startServer((socket, count) => {
      if (count === 1) socket.close(1001, "gateway restarting");
    });

    const config = runnerConfig(`ws://127.0.0.1:${port}/v1/runners/connect`);
    runner = new AylensRunner(config, await createRunnerRuntime(config, { proxyConfig: undefined, credentials: undefined }), {
      reconnect: { baseDelayMs: 20, maxDelayMs: 40 },
    });

    const served = runner.serve();
    await waitFor(() => getCount() >= 2, 5_000);

    expect(getCount()).toBeGreaterThanOrEqual(2);

    await runner.close();
    await served;
  });

  it("keeps retrying until the Gateway exists, then reports the failure", async () => {
    // 此时 Gateway 尚未启动：连接尝试必须明确失败并持续重试，不能让 Promise 永久挂起。
    const failures: number[] = [];
    const config = runnerConfig("ws://127.0.0.1:9/v1/runners/connect");
    runner = new AylensRunner(config, await createRunnerRuntime(config, { proxyConfig: undefined, credentials: undefined }), {
      reconnect: { baseDelayMs: 10, maxDelayMs: 20 },
      lifecycle: {
        connectionFailed: (_error, attempt) => failures.push(attempt),
      },
    });

    const served = runner.serve();
    await waitFor(() => failures.length >= 3, 5_000);

    expect(failures).toEqual([1, 2, 3]);

    await runner.close();
    await served;
  });

  it("stops reconnecting once closed", async () => {
    const { port, getCount } = await startServer((socket, count) => {
      if (count === 1) socket.close(1001, "gateway restarting");
    });

    const config = runnerConfig(`ws://127.0.0.1:${port}/v1/runners/connect`);
    runner = new AylensRunner(config, await createRunnerRuntime(config, { proxyConfig: undefined, credentials: undefined }), {
      reconnect: { baseDelayMs: 20, maxDelayMs: 40 },
    });

    const served = runner.serve();
    await waitFor(() => getCount() >= 2, 5_000);
    await runner.close();
    await served;

    const settled = getCount();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(getCount()).toBe(settled);
  });
});
