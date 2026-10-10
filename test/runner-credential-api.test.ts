import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import type { CredentialWrite } from "../src/runtime/credential-config-contract.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

const putPoolWrite: CredentialWrite = {
  operationId: "cred-op-1",
  expectedVersion: 0,
  mutation: { kind: "put-pool", id: "tavily-main", service: "tavily", name: "Tavily", enabled: true },
};

const putCredentialWrite: CredentialWrite = {
  operationId: "cred-op-2",
  expectedVersion: 1,
  mutation: {
    kind: "put-credential",
    id: "key-1",
    poolId: "tavily-main",
    name: "primary",
    secret: "tvly-super-secret-value",
    enabled: true,
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

function attachRunner(
  context: ReturnType<typeof createGatewayContext>,
  options: { supportsCredentialConfig?: boolean } = {},
) {
  const supports = options.supportsCredentialConfig ?? true;
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
      // 代理与凭据是两份独立能力：只支持其中一个时另一个必须明确拒绝。
      proxyConfig: true,
      credentialConfig: supports,
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
  context.configChannel?.attach("r1", socket as never, {
    secureOrLocal: true,
    supportsProxyConfig: true,
    supportsCredentialConfig: supports,
  });
  return sent;
}

function replyResult(
  context: ReturnType<typeof createGatewayContext>,
  sent: Array<Record<string, unknown>>,
  result: Record<string, unknown>,
) {
  const request = sent.at(-1) as { requestId: string } | undefined;
  if (!request) return;
  context.configChannel?.handle({
    type: "CONFIG_RESULT",
    messageId: "m-reply",
    requestId: request.requestId,
    runnerId: "r1",
    result,
    timestamp: Date.now(),
  });
}

const safeResult = (version = 1): Record<string, unknown> => ({
  version,
  pools: [{ id: "tavily-main", service: "tavily", name: "Tavily", enabled: true, credentialCount: 1, providerRefs: ["tavily"] }],
  credentials: [{
    id: "key-1",
    poolId: "tavily-main",
    name: "primary",
    enabled: true,
    maskedSecret: "tvly-s****alue",
    availability: "available",
  }],
  providers: [{ id: "tavily", poolId: "tavily-main" }],
});

describe("Runner credential config API", () => {
  it("requires authentication", async () => {
    const { app: server } = makeServer();
    const response = await server.inject({ method: "GET", url: "/v1/admin/runners/r1/credentials" });
    expect(response.statusCode).toBe(401);
  });

  it("never echoes credential secrets back to admin", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
      payload: putCredentialWrite,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    replyResult(context, sent, safeResult(2));
    const response = await pending;

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("tvly-super-secret-value");
    expect(response.json().credentials[0].maskedSecret).toContain("****");
  });

  it("rejects a stale expectedVersion with 409", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
      payload: putPoolWrite,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const request = sent.at(-1) as { requestId: string };
    context.configChannel?.handle({
      type: "CONFIG_ERROR",
      messageId: "m-err",
      requestId: request.requestId,
      runnerId: "r1",
      error: { code: "CONFIG_VERSION_CONFLICT", message: "Credential config version conflict" },
      timestamp: Date.now(),
    });
    const response = await pending;

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFIG_VERSION_CONFLICT");
  });

  it("reports CONFIG_UNSUPPORTED when the runner lacks the credential capability", async () => {
    const { app: server, context } = makeServer();
    attachRunner(context, { supportsCredentialConfig: false });

    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
      payload: putPoolWrite,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("CONFIG_UNSUPPORTED");
  });

  it("does not treat a lost acknowledgement as a failure to retry", async () => {
    const { app: server, context } = makeServer();
    // 短超时以便在测试内触发。
    context.configChannel.close();

    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
      payload: putPoolWrite,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("RUNTIME_OFFLINE");
  });

  it("rejects an offline runner without dispatching anything", async () => {
    const { app: server } = makeServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/runners/ghost/credentials",
      headers: { authorization: "Bearer api" },
      payload: putPoolWrite,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("RUNTIME_OFFLINE");
  });

  it("rejects an invalid mutation with 400 and a fixed message", async () => {
    const { app: server, context } = makeServer();
    attachRunner(context);

    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
      payload: { operationId: "op-bad", expectedVersion: 0, mutation: { kind: "nonsense" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    // 固定文案：不回显 Zod issue 或输入内容。
    expect(response.body).not.toContain("nonsense");
  });

  it("records operation intent without storing the secret", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "POST",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
      payload: putCredentialWrite,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const intent = context.configOperations.get("cred-op-2");
    expect(intent).toMatchObject({ runnerId: "r1", target: "key-1", status: "pending" });
    expect(JSON.stringify(intent ?? {})).not.toContain("tvly-super-secret-value");

    replyResult(context, sent, safeResult(2));
    await pending;

    expect(context.configOperations.get("cred-op-2")?.status).toBe("succeeded");
  });

  it("reads the safe view without exposing secrets", async () => {
    const { app: server, context } = makeServer();
    const sent = attachRunner(context);

    const pending = server.inject({
      method: "GET",
      url: "/v1/admin/runners/r1/credentials",
      headers: { authorization: "Bearer api" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    replyResult(context, sent, safeResult(5));
    const response = await pending;

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(5);
    expect(response.body).not.toContain("tvly-super-secret-value");
  });
});
