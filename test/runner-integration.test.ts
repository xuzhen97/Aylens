import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { AylensRunner } from "../src/runner/runner.js";
import { runnerConfigSchema } from "../src/runner/config.js";
import { createRunnerRuntime } from "../src/runner/runtime.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";
import { CredentialStore } from "../src/runner/credentials/store.js";
import { CredentialConfigService } from "../src/runner/credentials/service.js";

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

/** 通过原始 WebSocket 完成注册，并返回 Gateway 的单次响应。 */
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
    capabilities: { providerTypes: [], providerIds: [], browsers: [], profiles: [], http: true, browserAutomation: false },
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

    const runtime = await createRunnerRuntime(runnerConfig, { proxyConfig: undefined, credentials: undefined });
    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    const registered = context.runtimes.get("windows-test");
    expect(registered?.status).toBe("online");
    expect(registered?.capabilities.profiles).toContain("xhs-main");
    expect(registered?.capabilities.browsers).toContain("chrome");
    expect(registered?.capabilities.profileDetails).toEqual([
      {
        id: "xhs-main",
        browser: "chrome",
        mode: "launch",
        activeLeases: 0,
        maxConcurrency: 1,
        interactive: true,
        transport: "direct",
      },
    ]);
    expect(JSON.stringify(registered?.capabilities)).not.toContain("D:/profiles/xhs-main");

    // Heartbeat 应持续刷新动态 Lease，而不只是注册时上报一次静态 Profile 信息。
    const lease = runtime.profiles.acquire("xhs-main", "profile-status-test");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(context.runtimes.get("windows-test")?.capabilities.profileDetails?.[0]?.activeLeases).toBe(1);
    runtime.profiles.release(lease.id);
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
      providers: {
        remoteFixture: {
          type: "fixture-remote",
          options: {},
        },
      },
      transports: {
        direct: { type: "direct" },
      },
      browserProfiles: {},
    });

    const runtime = await createRunnerRuntime(runnerConfig, { proxyConfig: undefined, credentials: undefined });
    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    expect(context.runtimes.get("plugin-runner")?.capabilities.providerTypes)
      .toContain("fixture-remote");

    // 心跳必须上报每个已部署 Provider 的真实操作能力;
    // Gateway 据此拒绝向未声明 extract 的 Runner 派发提取任务。
    expect(context.runtimes.get("plugin-runner")?.capabilities.providerOperations)
      .toEqual({ remoteFixture: ["search"] });

    const result = await context.search.search({ query: "plugin-query" });

    expect(result.status).toBe("completed");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("plugin-query");
    expect(result.items[0]?.provenance.runtimeId).toBe("plugin-runner");
    expect(result.meta.providers.remoteFixture?.runtimeId).toBe("plugin-runner");

    expect(context.runtimes.get("plugin-runner")?.capabilities.authProviderIds)
      .toContain("remoteFixture");

    const checked = await context.dispatcher.auth("remoteFixture", "check");
    expect(checked).toMatchObject({
      runtimeId: "plugin-runner",
      output: {
        status: "authenticated",
        account: { handle: "@fixture", displayName: "Fixture User" },
      },
    });
    expect(context.runtimes.get("plugin-runner")?.capabilities.providerStates?.remoteFixture)
      .toMatchObject({ status: "authenticated", account: { handle: "@fixture" } });

    const login = await context.dispatcher.auth("remoteFixture", "login");
    expect(login.output).toMatchObject({ status: "auth_required" });
    // Runner 保留上一次识别到的账号，Admin 可以显示“哪个账号已失效”。
    expect(context.runtimes.get("plugin-runner")?.capabilities.providerStates?.remoteFixture)
      .toMatchObject({ status: "auth_required", account: { handle: "@fixture" } });
  });

  it("rejects a second Runner claiming an id that is already connected", async () => {
    const { context, wsUrl } = await startGateway({ "dup-runner": "dup-token" });

    const first = await rawRegister(wsUrl, "dup-token", "dup-runner");
    expect(first.answer).toMatchObject({ kind: "message", body: { type: "REGISTERED" } });

    const second = await rawRegister(wsUrl, "dup-token", "dup-runner");

    // 两个存活进程共享同一 ID 时不能互相循环替换；后来者应被明确拒绝并得到可记录的原因。
    expect(second.answer.kind).toBe("close");
    if (second.answer.kind !== "close") throw new Error("expected the Gateway to close the duplicate");
    expect(second.answer.code).toBe(1013);
    expect(second.answer.reason).toContain("already connected");

    // 当前存活实例继续持有该 ID。
    expect(context.runnerSessions.isAttached("dup-runner")).toBe(true);
    expect(context.runtimes.get("dup-runner")?.status).toBe("online");
  });

  it("lets a new Runner take over an id whose heartbeat went stale", async () => {
    const { context, wsUrl } = await startGateway({ "stale-runner": "stale-token" }, 150);

    const first = await rawRegister(wsUrl, "stale-token", "stale-runner");
    expect(first.answer).toMatchObject({ kind: "message", body: { type: "REGISTERED" } });

    // 当前实例从不发送 HEARTBEAT，因此超时后不能阻止替代实例接管。
    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await rawRegister(wsUrl, "stale-token", "stale-runner");
    expect(second.answer).toMatchObject({ kind: "message", body: { type: "REGISTERED" } });
    expect(context.runnerSessions.isAttached("stale-runner")).toBe(true);
  });
});

/**
 * 凭据接线：走**真实派发路径**验证 runner.ts 把凭据池接进了 Provider。
 *
 * 为何单独开一个 describe：既有测试都自己手搓 factory context，所以 421 个测试
 * 全绿也不能证明 `credentials` 被接上了（它曾经就是漏的）。这里用
 * `fake-credential-provider-plugin` 在 create() 阶段 fail closed，
 * 只有真实装配线通了、任务才可能成功。
 */
describe("Runner credential wiring", () => {
  it("hands the bound credential pool to a provider created for a dispatched job", async () => {
    const config = appConfigSchema.parse({
      version: 1,
      server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
      auth: { apiKey: "api", runnerTokens: { "cred-runner": "cred-token" } },
      runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 5000, jobTimeoutMs: 2000 },
      transports: { direct: { type: "direct" } },
      providers: {
        credProvider: {
          type: "fixture-credential",
          enabled: true,
          runtime: { selector: { providerType: "fixture-credential" } },
          options: {},
        },
      },
      routes: { default: { providers: ["credProvider"] } },
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
        id: "cred-runner",
        gatewayUrl: url.toString(),
        token: "cred-token",
        heartbeatMs: 50,
        maxJobs: 2,
        labels: { role: "credential-test" },
      },
      plugins: {
        baseDir: process.cwd(),
        modules: ["./test/fixtures/fake-credential-provider-plugin.mjs"],
      },
      providers: { credProvider: { type: "fixture-credential", options: {} } },
      transports: { direct: { type: "direct" } },
      browserProfiles: {},
    });

    // 凭据服务是真实装配的一部分：池 / Key / 绑定都写进真实的 Runner 库。
    // 池的 service 必须等于 Provider 的 type，否则 bind 会被服务归属校验拒绝。
    const credentialService = new CredentialConfigService(
      new CredentialStore(openSqlite(":memory:", runnerMigrations)),
      { credProvider: "fixture-credential" },
    );
    credentialService.write({
      operationId: "op-pool",
      expectedVersion: 0,
      mutation: { kind: "put-pool", id: "cred-main", service: "fixture-credential", name: "Cred", enabled: true },
    });
    credentialService.write({
      operationId: "op-key",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "cred-main",
        name: "primary",
        secret: "fixture-secret-value",
        enabled: true,
      },
    });
    credentialService.write({
      operationId: "op-bind",
      expectedVersion: 2,
      mutation: { kind: "bind", providerId: "credProvider", poolId: "cred-main" },
    });

    const runtime = await createRunnerRuntime(runnerConfig, {
      proxyConfig: undefined,
      credentials: credentialService,
    });
    runner = new AylensRunner(runnerConfig, runtime);
    await runner.connect();

    const result = await context.search.search({ query: "cred-query" });

    // 把 provider 错误带进断言消息：以后这条再红时能直接看到原因，
    // 而不是只看到一句 'failed' 却不知道是哪一步断的。
    expect(result.status, JSON.stringify(result.meta.providers)).toBe("completed");
    expect(result.items).toHaveLength(1);
    // 凭据池确实经由 runner.ts 的真实 context 到达了 Provider。
    // 少了这条接线，fixture 会在 create() 阶段直接抛错，上面两行不可能通过。
    expect(result.items[0]?.extensions).toMatchObject({
      poolId: "cred-main",
      credentialId: "key-1",
      hadSecret: true,
    });
    // secret 绝不进入 Gateway 可见的结果。
    expect(JSON.stringify(result)).not.toContain("fixture-secret-value");
  });
});
