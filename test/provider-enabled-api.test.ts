import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { appConfigSchema } from "../src/config/schema.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { ProviderSettingStore } from "../src/providers/provider-setting-store.js";
import { createMcpTools } from "../src/api/mcp/tools.js";
import { loginAdmin } from "./helpers/admin-server.js";

function buildServer(seed: Array<{ providerId: string; enabled: boolean }> = []) {
  const database = openSqlite(":memory:", gatewayMigrations);
  const store = new ProviderSettingStore(database);
  for (const item of seed) store.set(item.providerId, item.enabled, 1000);

  const config = appConfigSchema.parse({
    version: 1,
    server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
    auth: { apiKey: "admin-test-key", runnerTokens: {} },
    providers: {
      tavily: { type: "tavily", enabled: false },
      "url-fetch": { type: "url-fetch", enabled: true },
    },
    routes: { default: { providers: ["url-fetch"] } },
  });

  const context = createGatewayContext(config, { database });
  const app = buildHttpServer(context, { logger: false });
  return { app, context };
}

async function post(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ statusCode: number; json: () => unknown; body: string }> {
  // 显式标注返回值：app.inject 是重载方法，省略标注会推断出
  // `void & Promise<Response> & Chain` 这种不可用的交叉类型。
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "application/json",
      ...headers,
    },
    payload,
  });
  return response;
}

describe("POST /v1/providers/:providerId/enabled", () => {
  it("accepts an admin session cookie and reports the effective state", async () => {
    // 必须走 Cookie 会话：Bearer 分支在白名单校验之前就返回，
    // 只用 Bearer 测试根本无法暴露"浏览器跳登录页"。
    const { app } = buildServer();
    const { cookie, csrfToken } = await loginAdmin(app);

    const response = await post(app, "/v1/providers/tavily/enabled", { mode: "enabled" }, {
      cookie,
      "x-csrf-token": csrfToken,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providerId: "tavily",
      enabled: true,
      enabledMode: "enabled",
      enabledSource: "override",
    });
    await app.close();
  });

  it("re-enables a provider that is currently disabled", async () => {
    // INV-1 端到端：从"已被覆盖禁用"的状态启用回来。
    const { app } = buildServer([{ providerId: "url-fetch", enabled: false }]);
    const { cookie, csrfToken } = await loginAdmin(app);

    const response = await post(app, "/v1/providers/url-fetch/enabled", { mode: "enabled" }, {
      cookie,
      "x-csrf-token": csrfToken,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, enabledMode: "enabled" });
    await app.close();
  });

  it("returns to the config default in config mode", async () => {
    const { app } = buildServer([{ providerId: "url-fetch", enabled: false }]);
    const { cookie, csrfToken } = await loginAdmin(app);

    const response = await post(app, "/v1/providers/url-fetch/enabled", { mode: "config" }, {
      cookie,
      "x-csrf-token": csrfToken,
    });

    expect(response.json()).toEqual({
      providerId: "url-fetch",
      enabled: true,
      enabledMode: "config",
      enabledSource: "config",
    });
    await app.close();
  });

  it("rejects an unknown provider with 404 PROVIDER_NOT_FOUND", async () => {
    const { app } = buildServer();
    const { cookie, csrfToken } = await loginAdmin(app);

    const response = await post(app, "/v1/providers/ghost/enabled", { mode: "enabled" }, {
      cookie,
      "x-csrf-token": csrfToken,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "PROVIDER_NOT_FOUND" } });
    await app.close();
  });

  it("rejects an invalid mode with 400", async () => {
    const { app } = buildServer();
    const { cookie, csrfToken } = await loginAdmin(app);

    const response = await post(app, "/v1/providers/tavily/enabled", { mode: "maybe" }, {
      cookie,
      "x-csrf-token": csrfToken,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    await app.close();
  });

  it("rejects a write without the CSRF token", async () => {
    const { app } = buildServer();
    const { cookie } = await loginAdmin(app);

    const response = await post(app, "/v1/providers/tavily/enabled", { mode: "enabled" }, { cookie });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an unauthenticated write", async () => {
    const { app } = buildServer();
    const response = await post(app, "/v1/providers/tavily/enabled", { mode: "enabled" }, {});
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("provider enablement projections", () => {
  it("reflects overrides in the admin overview and its summary", async () => {
    const { app } = buildServer();
    const { cookie, csrfToken } = await loginAdmin(app);
    const headers = { cookie, "x-csrf-token": csrfToken };

    // 配置文件里 tavily=false、url-fetch=true。两次覆盖后恰好只有一个生效，
    // 这样 enabledProviders 才真正证明统计读的是生效值而不是配置文件。
    await post(app, "/v1/providers/tavily/enabled", { mode: "enabled" }, headers);
    await post(app, "/v1/providers/url-fetch/enabled", { mode: "disabled" }, headers);

    const overview = (await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie },
    })).json() as {
      summary: { enabledProviders: number };
      providers: Array<{ id: string; enabled: boolean; enabledMode: string }>;
    };

    expect(overview.providers.find((item) => item.id === "tavily"))
      .toMatchObject({ enabled: true, enabledMode: "enabled" });
    expect(overview.providers.find((item) => item.id === "url-fetch"))
      .toMatchObject({ enabled: false, enabledMode: "disabled" });
    expect(overview.summary.enabledProviders).toBe(1);
    await app.close();
  });

  it("reflects the override in GET /v1/providers and the MCP list_providers tool", async () => {
    const { app, context } = buildServer([{ providerId: "tavily", enabled: true }]);

    const listed = (await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: { host: "localhost:3000", authorization: "Bearer admin-test-key" },
    })).json() as { providers: Array<{ id: string; enabled: boolean; enabledMode: string }> };
    expect(listed.providers.find((item) => item.id === "tavily"))
      .toMatchObject({ enabled: true, enabledMode: "enabled" });

    const tool = createMcpTools(context).find((item) => item.name === "list_providers");
    const viaTool = await tool!.execute({}) as {
      providers: Array<{ id: string; enabled: boolean; enabledMode: string }>;
    };
    expect(viaTool.providers.find((item) => item.id === "tavily"))
      .toMatchObject({ enabled: true, enabledMode: "enabled" });
    await app.close();
  });
});
