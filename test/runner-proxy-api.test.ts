import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import type { ProxyWrite } from "../src/runtime/proxy-config-contract.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

const sampleWrite: ProxyWrite = {
  operationId: "op-e2e-1",
  expectedVersion: 1,
  mutation: {
    kind: "put",
    id: "proxy-new",
    type: "http-proxy",
    address: "http://127.0.0.1:8899",
    credentials: { action: "clear" },
  },
};

function makeServer() {
  const config = appConfigSchema.parse({
    version: 1,
    server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
    auth: { apiKey: "api", runnerTokens: { r1: "runner-token" } },
    runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 5000, jobTimeoutMs: 1000 },
    providers: {},
    routes: { default: { providers: [] } },
  });
  const context = createGatewayContext(config, { database: openSqlite(":memory:", gatewayMigrations) });
  app = buildHttpServer(context, { logger: false });
  return { context, app };
}

function attachRunner(context: ReturnType<typeof createGatewayContext>, options: { supportsProxyConfig?: boolean } = {}) {
  context.runtimes.upsert({
    id: "r1",
    hostname: "test-host",
    os: "windows",
    version: "1",
    protocolVersion: "1",
    status: "online",
    labels: {},
    capabilities: {
      providerTypes: [],
      providerIds: [],
      browsers: [],
      profiles: [],
      proxyConfig: options.supportsProxyConfig ?? true,
      http: true,
      browserAutomation: false,
    },
    capacity: { maxJobs: 1, activeJobs: 0 },
    lastSeenAt: Date.now(),
  });

  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
    close: () => undefined,
  };
  context.runnerSessions.attach("r1", socket as never);
  context.configChannel?.attach("r1", socket as never, { secureOrLocal: true, supportsProxyConfig: options.supportsProxyConfig ?? true, supportsCredentialConfig: false });
  return sent;
}

/** 模拟 Runner 回执配置结果。 */
function replyConfigResult(context: ReturnType<typeof createGatewayContext>, sent: Array<Record<string, unknown>>, version = 2) {
  const request = sent[0] as { requestId: string } | undefined;
  if (!request) return;
  context.configChannel?.handle({
    type: "CONFIG_RESULT",
    messageId: "m-reply",
    requestId: request.requestId,
    runnerId: "r1",
    result: {
      version,
      proxies: [{ id: "direct", type: "direct", hasCredentials: false, providerRefs: [], profileRefs: [] }],
      providers: [],
      browserRestartRequired: [],
    },
    timestamp: Date.now(),
  });
}

describe("Runner proxy config API", () => {
  it("requires authentication", async () => {
    const { app: server } = makeServer();
    const response = await server.inject({ method: "GET", url: "/v1/admin/runners/r1/proxy-config" });
    expect(response.statusCode).toBe(401);
  });

  it("accepts a valid bearer read and returns the safe config", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "GET",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer api" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    replyConfigResult(context, sent, 7);
    const response = await pending;

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(7);
  });

  it("rejects an invalid bearer without cookie fallback", async () => {
    const { app: server } = makeServer();
    const response = await server.inject({
      method: "GET",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an offline runner without dispatching anything", async () => {
    const { app: server } = makeServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/runners/ghost/proxy-config",
      headers: { authorization: "Bearer api" },
      payload: sampleWrite,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("RUNTIME_OFFLINE");
  });

  it("dispatches a write to a supported runner and returns the safe result", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer api" },
      payload: sampleWrite,
    });
    // 等待 dispatch 后再回执。
    await new Promise((resolve) => setTimeout(resolve, 20));
    replyConfigResult(context, sent, 2);
    const response = await pending;

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(2);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("records the operation intent before dispatch and the result afterwards", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer api" },
      payload: sampleWrite,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 派发后、回执前:意图已记录,状态 pending。
    const intent = context.configOperations.get(sampleWrite.operationId);
    expect(intent).toMatchObject({ runnerId: "r1", target: "proxy-new", status: "pending" });

    replyConfigResult(context, sent, 2);
    await pending;

    const finished = context.configOperations.get(sampleWrite.operationId);
    expect(finished?.status).toBe("succeeded");
  });

  it("maps CONFIG_VERSION_CONFLICT to 409", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer api" },
      payload: sampleWrite,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const request = sent[0] as { requestId: string };
    context.configChannel?.handle({
      type: "CONFIG_ERROR",
      messageId: "m-err",
      requestId: request.requestId,
      runnerId: "r1",
      error: { code: "CONFIG_VERSION_CONFLICT", message: "Proxy config version conflict" },
      timestamp: Date.now(),
    });
    const response = await pending;

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFIG_VERSION_CONFLICT");
  });

  it("rejects an invalid mutation with 400 and a fixed message", async () => {
    const { app: server, context } = makeServer();
    attachRunner(context);

    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer api" },
      payload: { operationId: "op-bad", expectedVersion: 1, mutation: { kind: "nonsense" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("does not leak credentials into logs, responses or the operations table", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/proxy-config",
      headers: { authorization: "Bearer api" },
      payload: {
        ...sampleWrite,
        mutation: {
          kind: "put", id: "proxy-secret", type: "http-proxy",
          address: "http://127.0.0.1:8899",
          credentials: { action: "replace", username: "user", password: "top-secret-password" },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    replyConfigResult(context, sent, 2);
    const response = await pending;

    expect(response.body).not.toContain("top-secret-password");
    const opRow = context.configOperations.get("op-e2e-1");
    expect(JSON.stringify(opRow ?? {})).not.toContain("top-secret-password");
    // target 是代理 ID(proxy-secret),合法;但凭据、地址与 mutation JSON 不得进入操作表。
    expect(JSON.stringify(opRow ?? {})).not.toContain("127.0.0.1:8899");
    expect(JSON.stringify(opRow ?? {})).not.toContain("user");
  });
});
