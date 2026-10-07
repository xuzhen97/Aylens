import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";


let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function createAdminServer() {
  const config = appConfigSchema.parse({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 3000,
      runnerPath: "/v1/runners/connect",
    },
    auth: {
      apiKey: "admin-api-key-do-not-expose",
      runnerTokens: {
        runner: "runner-token-do-not-expose",
      },
    },
    runtimeRegistry: {
      heartbeatTimeoutMs: 1000,
      offlineAfterMs: 5000,
      jobTimeoutMs: 1000,
    },
    transports: {
      direct: { type: "direct" },
    },
    providers: {
      browserRead: {
        type: "generic-browser",
        enabled: true,
        runtime: {
          selector: {
            providerType: "generic-browser",
            labels: {
              apiToken: "selector-label-secret",
              region: "test",
            },
          },
        },
        transport: {
          primary: "privateProxy",
          fallback: [],
        },
        browser: {
          profile: "local-profile",
        },
        options: {
          internalNote: "provider-option-must-not-be-returned",
        },
      },
    },
    routes: {
      default: {
        providers: ["browserRead"],
      },
    },
  });

  const context = createGatewayContext(config);
  context.audit.start(
    "request-admin-test",
    "trace-admin-test",
    {
      query: "https://example.com/account?token=audit-secret-token&view=profile",
      sources: ["browserRead"],
    },
  );
  context.audit.addProviderEvent("request-admin-test", {
    providerId: "browserRead",
    runtimeId: "test-runner",
    startedAt: Date.now() - 20,
    completedAt: Date.now(),
    status: "success",
    resultCount: 1,
  });
  context.audit.finish("request-admin-test", "completed");

  app = buildHttpServer(context, {
    logger: false,
    adminStaticRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../apps/admin/dist"),
  });
  return { app, context };
}

describe("admin UI", () => {
  it("serves the admin shell without embedding credentials", async () => {
    const { app } = createAdminServer();
    const response = await app.inject({ method: "GET", url: "/admin" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("<div id=\"root\"></div>");
    expect(response.body).not.toContain("admin-api-key-do-not-expose");
    expect(response.body).not.toContain("runner-token-do-not-expose");
  });

  it("serves the external React bundle for all supported deep links", async () => {
    const { app } = createAdminServer();
    for (const url of ["/admin", "/admin/", "/admin/login", "/admin/runtimes", "/admin/providers", "/admin/profiles", "/admin/audits", "/admin/tester"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
      expect(response.body).toContain("/admin/assets/");
    }
    expect((await app.inject("/admin/unknown")).statusCode).toBe(404);
    expect((await app.inject("/admin/assets/missing.js")).statusCode).toBe(404);
  });

  it("does not embed API keys in the external SPA shell", async () => {
    const { app } = createAdminServer();
    const response = await app.inject("/admin/tester");
    expect(response.body).not.toContain("sessionStorage");
    expect(response.body).not.toContain("admin-api-key-do-not-expose");
  });

  it("protects admin data with the existing Gateway API key", async () => {
    const { app } = createAdminServer();

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
    });

    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: {
        authorization: "Bearer admin-api-key-do-not-expose",
      },
    });

    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      summary: {
        providers: 1,
        enabledProviders: 1,
        // 此测试夹具没有连接 Runner，因此节点列表应为空。
        runtimes: 0,
        onlineRuntimes: 0,
        browserProfiles: 0,
        recentAudits: 1,
      },
      providers: [
        {
          id: "browserRead",
          type: "generic-browser",
        },
      ],
    });
  });

  it("shows safe Runner Browser Profile runtime state", async () => {
    const { app, context } = createAdminServer();
    context.runtimes.upsert({
      id: "profile-runner",
      hostname: "profile-host",
      os: "windows",
      version: "0.1.0",
      protocolVersion: "1",
      status: "online",
      labels: {},
      capabilities: {
        providerTypes: ["generic-browser"],
        providerIds: ["browserRead"],
        browsers: ["chrome"],
        profiles: ["browser-main"],
        profileDetails: [{
          id: "browser-main",
          browser: "chrome",
          mode: "launch",
          activeLeases: 1,
          maxConcurrency: 1,
          interactive: false,
          transport: "direct",
        }],
        http: true,
        browserAutomation: true,
      },
      capacity: { maxJobs: 1, activeJobs: 0 },
      lastSeenAt: Date.now(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: { authorization: "Bearer admin-api-key-do-not-expose" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().browserProfiles).toEqual([{
      id: "browser-main",
      scope: "runner",
      runtimeId: "profile-runner",
      status: "busy",
      browser: "chrome",
      mode: "launch",
      activeLeases: 1,
      maxConcurrency: 1,
      interactive: false,
      transport: "direct",
    }]);
  });

  it("redacts sensitive configuration and audit URL parameters", async () => {
    const { app } = createAdminServer();

    const overview = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: {
        authorization: "Bearer admin-api-key-do-not-expose",
      },
    });

    const body = overview.body;
    expect(body).not.toContain("admin-api-key-do-not-expose");
    expect(body).not.toContain("runner-token-do-not-expose");
    expect(body).not.toContain("provider-option-must-not-be-returned");
    expect(body).not.toContain("selector-label-secret");
    expect(body).not.toContain("audit-secret-token");

    const payload = overview.json();
    expect(payload.audits[0].request.query).toContain("token=***");
    expect(payload.providers[0].runtime.selector.labels).toEqual({
      apiToken: "***",
      region: "test",
    });
  });

  it("exposes only safe provider auth status and routes Admin auth actions through the dispatcher", async () => {
    const config = appConfigSchema.parse({
      version: 1,
      auth: { apiKey: "api", runnerTokens: {} },
      providers: { x: { type: "x-search" } },
      routes: { default: { providers: [] } },
    });
    const context = createGatewayContext(config);
    context.runtimes.upsert({
      id: "x-runner",
      hostname: "x-host",
      os: "windows",
      version: "1",
      protocolVersion: "1",
      status: "online",
      labels: {},
      capabilities: {
        providerTypes: ["x-search"],
        providerIds: ["x"],
        authProviderIds: ["x"],
        providerStates: {
          x: {
            status: "authenticated",
            account: { handle: "@demo", displayName: "Demo User" },
            checkedAt: 1_790_000_000_000,
          },
        },
        browsers: ["chrome"],
        profiles: ["browser-main"],
        http: true,
        browserAutomation: true,
      },
      capacity: { maxJobs: 1, activeJobs: 0 },
      lastSeenAt: Date.now(),
    });
    const auth = vi.spyOn(context.dispatcher, "auth").mockResolvedValue({
      runtimeId: "x-runner",
      output: {
        status: "auth_required",
        account: { handle: "@demo", displayName: "Demo User" },
        checkedAt: Date.now(),
      },
    });
    app = buildHttpServer(context, {
      logger: false,
      adminStaticRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../apps/admin/dist"),
    });

    const overview = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: { authorization: "Bearer api" },
    });
    expect(overview.json().providers[0]).toMatchObject({
      id: "x",
      authControl: true,
      authRuntimeId: "x-runner",
      auth: {
        status: "authenticated",
        account: { handle: "@demo", displayName: "Demo User" },
      },
    });
    expect(overview.body).not.toContain("cookie");
    expect(overview.body).not.toContain("token");

    const login = await app.inject({
      method: "POST",
      url: "/v1/providers/x/auth/login",
      headers: { authorization: "Bearer api" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      providerId: "x",
      runtimeId: "x-runner",
      auth: { status: "auth_required", account: { handle: "@demo" } },
    });
    expect(auth).toHaveBeenCalledWith("x", "login");
  });
});
