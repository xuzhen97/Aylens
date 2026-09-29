import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { ADMIN_HTML, renderAdminPage } from "../src/api/http/admin-page.js";

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

  app = buildHttpServer(context);
  return { app, context };
}

describe("admin UI", () => {
  it("serves the admin shell without embedding credentials", async () => {
    const { app } = createAdminServer();

    const response = await app.inject({
      method: "GET",
      url: "/admin",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Aylens 控制台");
    expect(response.body).toContain("基础设施运行总览");
    expect(response.body).not.toContain("admin-api-key-do-not-expose");
    expect(response.body).not.toContain("runner-token-do-not-expose");
  });

  it("contains syntactically valid inline JavaScript on every admin page", () => {
    for (const page of ["overview", "runtimes", "providers", "profiles", "audits", "tester"] as const) {
      const html = renderAdminPage(page);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1] ?? "");

      expect(scripts).toHaveLength(2);
      for (const script of scripts) {
        expect(() => new Function(script)).not.toThrow();
      }
    }
  });

  it("serves separate admin routes instead of stacking every module on one page", async () => {
    const { app } = createAdminServer();
    const pages = [
      ["/admin", "overview", "id=\"runtimeSummary\""],
      ["/admin/runtimes", "runtimes", "id=\"runtimeRows\""],
      ["/admin/providers", "providers", "id=\"providerGrid\""],
      ["/admin/profiles", "profiles", "id=\"profileGrid\""],
      ["/admin/audits", "audits", "id=\"auditRows\""],
      ["/admin/tester", "tester", "id=\"searchForm\""],
    ] as const;

    for (const [url, page, marker] of pages) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`data-page="${page}"`);
      expect(response.body).toContain(marker);
      expect(response.body).toContain(`class="active" href="${url}"`);
    }

    const providers = await app.inject({ method: "GET", url: "/admin/providers" });
    expect(providers.body).not.toContain('id="runtimeRows"');
    expect(providers.body).not.toContain('id="auditRows"');
    expect(providers.body).not.toContain('id="searchForm"');

    const tester = await app.inject({ method: "GET", url: "/admin/tester" });
    expect(tester.body).not.toContain('id="providerGrid"');
    expect(tester.body).not.toContain('id="runtimeRows"');
  });

  it("renders provider execution diagnostics on the request tester", () => {
    const tester = renderAdminPage("tester");

    expect(tester).toContain("appendProviderFailures");
    expect(tester).toContain("Gateway 返回的实际 Provider 错误");
    expect(tester).toContain("error.code");
    expect(tester).toContain("meta.runtimeId");
    expect(tester).toContain("error.retryable");
    expect(tester).toContain("meta.latencyMs");
  });

  it("keeps the request tester provider selection across auto-refreshes", () => {
    const tester = renderAdminPage("tester");
    // 回归测试：自动刷新不能重建 Provider 选项并清空用户选择；选项不变时必须恢复原值。
    expect(tester).toMatch(/s\.dataset\.keys/);
    expect(tester).toMatch(/Array\.from\(s\.options\)\.some/);
  });

  it("supports system, light, and dark themes with a persistent theme preference", () => {
    expect(ADMIN_HTML).toContain('value="system"');
    expect(ADMIN_HTML).toContain('value="light"');
    expect(ADMIN_HTML).toContain('value="dark"');
    expect(ADMIN_HTML).toContain("aylens.admin.theme");
    expect(ADMIN_HTML).toContain('html[data-theme="light"]');
    expect(ADMIN_HTML).toContain("prefers-color-scheme: dark");
    expect(ADMIN_HTML).toContain("localStorage.setItem(THEME");
    expect(ADMIN_HTML).toContain("sessionStorage.getItem(KEY)");
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
});
