import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { AylensRunner } from "../src/runner/runner.js";
import { connectWithRetry, maintainConnection } from "../src/runner/connect.js";
import { runnerConfigSchema } from "../src/runner/config.js";
import { createRunnerRuntime } from "../src/runner/runtime.js";

describe("connectWithRetry", () => {
  it("retries until the gateway accepts the connection", async () => {
    let attempts = 0;
    const runner = {
      connect: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      },
    };

    await connectWithRetry(runner, () => false, 1);

    expect(attempts).toBe(3);
  });

  it("gives up once shutdown has started", async () => {
    let attempts = 0;
    let stopping = false;
    const runner = {
      connect: async () => {
        attempts += 1;
        stopping = true;
        throw new Error("connect ECONNREFUSED");
      },
    };

    await connectWithRetry(runner, () => stopping, 1);

    expect(attempts).toBe(1);
  });

  it("reconnects after an established gateway connection closes", async () => {
    let attempts = 0;
    let stopping = false;
    const runner = {
      connect: async () => {
        attempts += 1;
        if (attempts === 2) stopping = true;
      },
      waitForDisconnect: async () => undefined,
    };

    await maintainConnection(runner, () => stopping, { retryMs: 1 });

    expect(attempts).toBe(2);
  });
});

let app: FastifyInstance | undefined;
let runner: AylensRunner | undefined;
const rawSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of rawSockets) socket.terminate();
  rawSockets.length = 0;

  if (runner) await runner.close();
  runner = undefined;

  if (app) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.close();
    app = undefined;
  }
});

type RawAnswer =
  | { kind: "message"; body: Record<string, unknown> }
  | { kind: "close"; code: number; reason: string };

async function startGateway(
  runnerTokens: Record<string, string>,
  heartbeatTimeoutMs = 1000,
): Promise<{ context: ReturnType<typeof createGatewayContext>; wsUrl: string }> {
  const config = appConfigSchema.parse({
    version: 1,
    server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
    auth: { apiKey: "api", runnerTokens },
    runtimeRegistry: { heartbeatTimeoutMs, offlineAfterMs: 60_000, jobTimeoutMs: 1000 },
    transports: { direct: { type: "direct" } },
    providers: {},
    routes: { default: { providers: [] } },
    browserProfiles: {},
  });

  const context = createGatewayContext(config);
  app = buildHttpServer(context);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const wsUrl = new URL(address);
  wsUrl.protocol = "ws:";
  wsUrl.pathname = config.server.runnerPath;

  return { context, wsUrl: wsUrl.toString() };
}

/** Registers over a raw socket, returning the Gateway's single answer. */
async function rawRegister(
  wsUrl: string,
  token: string,
  runnerId: string,
): Promise<{ socket: WebSocket; answer: RawAnswer }> {
  const socket = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  rawSockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const answer = new Promise<RawAnswer>((resolve) => {
    socket.once("message", (raw) => resolve({ kind: "message", body: JSON.parse(raw.toString()) as Record<string, unknown> }));
    socket.once("close", (code, reason) => resolve({ kind: "close", code, reason: reason.toString() }));
  });

  socket.send(JSON.stringify({
    type: "REGISTER",
    messageId: "msg-register",
    protocolVersion: "1",
    runnerId,
    hostname: "test-host",
    os: "windows",
    version: "0.1.0",
    labels: {},
    capabilities: { providerTypes: [], browsers: [], profiles: [], http: true, browserAutomation: false },
    capacity: { maxJobs: 1, activeJobs: 0 },
    timestamp: Date.now(),
  }));

  return { socket, answer: await answer };
}

describe("Gateway/Runner integration", () => {
  it("registers an outbound runner and exposes its capabilities", async () => {
    const config = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
      auth: { apiKey: "api", runnerTokens: { "windows-test": "runner-token" } },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 5000, jobTimeoutMs: 1000 },
      transports: { direct: { type: "direct" } },
      providers: {},
      routes: { default: { providers: [] } },
      browserProfiles: {},
    });

    const context = createGatewayContext(config);
    app = buildHttpServer(context);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(address);
    url.protocol = "ws:";
    url.pathname = config.server.runnerPath;

    const runnerConfig = runnerConfigSchema.parse({
      runner: {
        id: "windows-test",
        gatewayUrl: url.toString(),
        token: "runner-token",
        heartbeatMs: 50,
        maxJobs: 1,
        labels: { role: "browser" },
      },
      plugins: { baseDir: ".", modules: [] },
      capabilities: {
        browsers: ["chrome"],
        http: true,
        browserAutomation: true,
      },
      transports: {
        direct: { type: "direct" },
      },
      browserProfiles: {
        "xhs-main": {
          browser: "chrome",
          mode: "launch",
          persistent: true,
          userDataDir: "D:/profiles/xhs-main",
          maxConcurrency: 1,
          interactive: true,
          headless: true,
          channel: "chrome",
          args: [],
        },
      },
    });

    const runtime = await createRunnerRuntime(runnerConfig);
    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    const registered = context.runtimes.get("windows-test");
    expect(registered?.status).toBe("online");
    expect(registered?.capabilities.profiles).toContain("xhs-main");
    expect(registered?.capabilities.browsers).toContain("chrome");
  });

  it("executes a configured provider through a dynamically loaded Runner plugin", async () => {
    const config = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
      auth: { apiKey: "api", runnerTokens: { "plugin-runner": "plugin-token" } },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 5000, jobTimeoutMs: 2000 },
      transports: { direct: { type: "direct" } },
      providers: {
        remoteFixture: {
          type: "fixture-remote",
          enabled: true,
          runtime: {
            selector: {
              providerType: "fixture-remote",
            },
          },
          options: {},
        },
      },
      routes: { default: { providers: ["remoteFixture"] } },
      browserProfiles: {},
    });

    const context = createGatewayContext(config);
    app = buildHttpServer(context);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(address);
    url.protocol = "ws:";
    url.pathname = config.server.runnerPath;

    const runnerConfig = runnerConfigSchema.parse({
      runner: {
        id: "plugin-runner",
        gatewayUrl: url.toString(),
        token: "plugin-token",
        heartbeatMs: 50,
        maxJobs: 2,
        labels: { role: "plugin-test" },
      },
      plugins: {
        baseDir: process.cwd(),
        modules: ["./test/fixtures/fake-provider-plugin.mjs"],
      },
      capabilities: {
        browsers: [],
        http: true,
        browserAutomation: false,
      },
      transports: {
        direct: { type: "direct" },
      },
      browserProfiles: {},
    });

    const runtime = await createRunnerRuntime(runnerConfig);
    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    expect(context.runtimes.get("plugin-runner")?.capabilities.providerTypes)
      .toContain("fixture-remote");

    const result = await context.search.search({ query: "plugin-query" });

    expect(result.status).toBe("completed");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("plugin-query");
    expect(result.items[0]?.provenance.runtimeId).toBe("plugin-runner");
    expect(result.meta.providers.remoteFixture?.runtimeId).toBe("plugin-runner");
  });

  it("rejects a second Runner claiming an id that is already connected", async () => {
    const { context, wsUrl } = await startGateway({ "dup-runner": "dup-token" });

    const first = await rawRegister(wsUrl, "dup-token", "dup-runner");
    expect(first.answer).toMatchObject({ kind: "message", body: { type: "REGISTERED" } });

    const second = await rawRegister(wsUrl, "dup-token", "dup-runner");

    // Two live processes sharing one id used to replace each other in a loop:
    // each reconnect kicked the other, forever. The newcomer is turned away with
    // a reason it can log instead.
    expect(second.answer.kind).toBe("close");
    if (second.answer.kind !== "close") throw new Error("expected the Gateway to close the duplicate");
    expect(second.answer.code).toBe(1013);
    expect(second.answer.reason).toContain("already connected");

    // The incumbent keeps the id.
    expect(context.runnerSessions.isAttached("dup-runner")).toBe(true);
    expect(context.runtimes.get("dup-runner")?.status).toBe("online");
  });

  it("lets a new Runner take over an id whose heartbeat went stale", async () => {
    const { context, wsUrl } = await startGateway({ "stale-runner": "stale-token" }, 150);

    const first = await rawRegister(wsUrl, "stale-token", "stale-runner");
    expect(first.answer).toMatchObject({ kind: "message", body: { type: "REGISTERED" } });

    // The incumbent never sends HEARTBEAT, so it must not block its replacement.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await rawRegister(wsUrl, "stale-token", "stale-runner");
    expect(second.answer).toMatchObject({ kind: "message", body: { type: "REGISTERED" } });
    expect(context.runnerSessions.isAttached("stale-runner")).toBe(true);
  });
});
