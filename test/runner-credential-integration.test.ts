import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { AylensRunner } from "../src/runner/runner.js";
import { runnerConfigSchema } from "../src/runner/config.js";
import { createRunnerRuntime } from "../src/runner/runtime.js";
import { CredentialStore } from "../src/runner/credentials/store.js";
import { CredentialConfigService } from "../src/runner/credentials/service.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { loginAdmin } from "./helpers/admin-server.js";

/**
 * 凭据管理的**端到端**回归测试：真实 WS 注册 + 真实凭据服务 + Cookie 会话。
 *
 * 它专门盯住两个已经发生过的断点，两者都不会让既有的 Bearer 单测变红：
 * 1. `COOKIE_AUTH_ROUTES` 漏加路由 → 浏览器 401 → 前端跳登录页；
 * 2. `runner-gateway` 的 attach 漏传 `supportsCredentialConfig` →
 *    浏览器永远拿到 CONFIG_UNSUPPORTED（界面显示“不支持凭据管理”）。
 */
let app: FastifyInstance | undefined;
let runner: AylensRunner | undefined;
let database: DatabaseSync | undefined;

afterEach(async () => {
  if (runner) await runner.close();
  runner = undefined;
  if (app) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.close();
    app = undefined;
  }
  try {
    database?.close();
  } catch { /* already closed by gateway context */ }
  database = undefined;
});

async function startStack() {
  const config = appConfigSchema.parse({
    version: 1,
    server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
    auth: { apiKey: "admin-test-key", runnerTokens: { "cred-runner": "cred-token" } },
    runtimeRegistry: { heartbeatTimeoutMs: 5_000, offlineAfterMs: 60_000, jobTimeoutMs: 1_000 },
    providers: {},
    routes: { default: { providers: [] } },
  });
  // Gateway 也用内存库：默认路径是真实文件库，会与正在跑的 dev Gateway 抢锁。
  const context = createGatewayContext(config, {
    database: openSqlite(":memory:", gatewayMigrations),
  });
  app = buildHttpServer(context, { logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const wsUrl = new URL(address);
  wsUrl.protocol = "ws:";
  wsUrl.pathname = config.server.runnerPath;

  const runnerConfig = runnerConfigSchema.parse({
    runner: {
      id: "cred-runner",
      gatewayUrl: wsUrl.toString(),
      token: "cred-token",
      heartbeatMs: 200,
      maxJobs: 2,
    },
    plugins: { baseDir: process.cwd(), modules: ["builtin:tavily"] },
    providers: { tavily: { type: "tavily", options: {} } },
    transports: { direct: { type: "direct" } },
    browserProfiles: {},
  });

  // Runner 侧：真实凭据服务（内存库），与生产同一条装配路径。
  database = openSqlite(":memory:", runnerMigrations);
  const credentialService = new CredentialConfigService(
    new CredentialStore(database),
    { tavily: "tavily" },
  );

  const runtime = await createRunnerRuntime(runnerConfig, {
    // 本测试只验证凭据链路，代理服务传 undefined。
    proxyConfig: undefined,
    credentials: credentialService,
  });
  runner = new AylensRunner(runnerConfig, runtime);
  await runner.connect();

  // 等注册完成，否则 capability 还没进 Gateway 的注册表。
  const deadline = Date.now() + 3_000;
  while (!context.runtimes.get("cred-runner") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return { context, credentialService };
}

const cookieHeaders = (cookie: string, csrfToken?: string) => ({
  host: "localhost:3000",
  origin: "http://localhost:3000",
  cookie,
  ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
});

describe("credential config end to end", () => {
  it("reports the credential capability over the real WebSocket handshake", async () => {
    const { context } = await startStack();

    expect(context.runtimes.get("cred-runner")?.capabilities.credentialConfig).toBe(true);
  });

  it("lets an admin session read and write credentials without leaving the page", async () => {
    await startStack();
    const { cookie, csrfToken } = await loginAdmin(app!);

    // 浏览器用的正是 cookie 分支：漏加白名单时会 401。
    const read = await app!.inject({
      method: "GET",
      url: "/v1/admin/runners/cred-runner/credentials",
      headers: cookieHeaders(cookie),
    });
    expect(read.statusCode, `读取凭据失败：${read.body}`).toBe(200);
    expect(read.json()).toMatchObject({ version: 0, pools: [], credentials: [] });

    // 未绑定的 Provider 也要出现在视图里，否则界面无从发起绑定；service 用于只展示匹配的池。
    expect(read.json().providers).toEqual([{ id: "tavily", poolId: null, service: "tavily" }]);

    const poolWrite = {
      operationId: "op-1",
      expectedVersion: 0,
      mutation: { kind: "put-pool", id: "tavily-main", service: "tavily", name: "Tavily", enabled: true },
    };
    const created = await app!.inject({
      method: "POST",
      url: "/v1/admin/runners/cred-runner/credentials",
      headers: cookieHeaders(cookie, csrfToken),
      payload: poolWrite,
    });
    expect(created.statusCode).toBe(200);

    const keyWrite = {
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "primary",
        secret: "tvly-e2e-secret-value",
        enabled: true,
        accountGroup: "team-a",
      },
    };
    const withKey = await app!.inject({
      method: "POST",
      url: "/v1/admin/runners/cred-runner/credentials",
      headers: cookieHeaders(cookie, csrfToken),
      payload: keyWrite,
    });

    expect(withKey.statusCode).toBe(200);
    // 明文绝不回传；账号分组要落库，否则账号级限流无法生效。
    expect(withKey.body).not.toContain("tvly-e2e-secret-value");
    expect(withKey.json().credentials[0]).toMatchObject({
      id: "key-1",
      accountGroup: "team-a",
      maskedSecret: expect.stringContaining("****"),
    });

    // 绑定 Provider → 池，使 Provider 真正取得到 Key。
    const bound = await app!.inject({
      method: "POST",
      url: "/v1/admin/runners/cred-runner/credentials",
      headers: cookieHeaders(cookie, csrfToken),
      payload: { operationId: "op-3", expectedVersion: 2, mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" } },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().providers).toEqual([{ id: "tavily", poolId: "tavily-main", service: "tavily" }]);
  });

  it("keeps the write path rejected for a stale version", async () => {
    await startStack();
    const { cookie, csrfToken } = await loginAdmin(app!);

    const response = await app!.inject({
      method: "POST",
      url: "/v1/admin/runners/cred-runner/credentials",
      headers: cookieHeaders(cookie, csrfToken),
      payload: {
        operationId: "op-stale",
        expectedVersion: 99,
        mutation: { kind: "put-pool", id: "p", service: "tavily", name: "p", enabled: true },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFIG_VERSION_CONFLICT");
  });
});
