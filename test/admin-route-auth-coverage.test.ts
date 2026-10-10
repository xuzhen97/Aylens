import { describe, expect, it } from "vitest";
import { buildHttpServer } from "../src/api/http/server.js";
import { COOKIE_AUTH_ROUTES } from "../src/api/http/admin-security.js";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { gatewayMigrations } from "../src/storage/gateway-migrations.js";
import { collectRegisteredRoutes } from "./helpers/fastify-routes.js";
import { loginAdmin } from "./helpers/admin-server.js";

/**
 * 路由鉴权覆盖守卫。
 *
 * 背景：`COOKIE_AUTH_ROUTES` 是一份**与路由注册分离的白名单**。
 * 漏加一条路由不会编译报错、也不会让既有测试变红——因为单测普遍用
 * `Authorization: Bearer`，而 Bearer 分支在白名单校验之前就返回了。
 * 真实后果是浏览器访问 401 → 前端跳登录页（API 凭据页就是这样中过的）。
 *
 * 这里做两件事：
 * 1. 枚举所有已注册的 /v1 路由，要求每条都被**显式归类**；
 * 2. 对每条 Cookie 会话路由发一次真实请求，确认不是 401。
 */

/** 无需任何鉴权的会话路由（由 server.ts 的 preHandler 显式放行）。 */
const UNAUTHENTICATED_ROUTES = new Set([
  "GET /v1/admin/session",
  "POST /v1/admin/session/login",
  "POST /v1/admin/session/logout",
]);

/**
 * 只允许 Bearer 的公共 API 面。
 *
 * 刻意不开放 Cookie 会话：Cookie 凭据不应暴露给外部调用方，
 * 新增公共 API 时必须在这里写明，而不是默默继承默认行为。
 */
const BEARER_ONLY_ROUTES = new Set([
  "GET /v1/audit/:requestId",
  "GET /v1/providers",
  "GET /v1/runtimes",
  "POST /v1/extract",
]);

function buildServer() {
  const config = appConfigSchema.parse({
    version: 1,
    server: { host: "127.0.0.1", port: 3000, runnerPath: "/v1/runners/connect" },
    auth: { apiKey: "admin-test-key", runnerTokens: {} },
    providers: { tavily: { type: "tavily" } },
    routes: { default: { providers: [] } },
  });
  const context = createGatewayContext(config, { database: openSqlite(":memory:", gatewayMigrations) });
  const app = buildHttpServer(context, { logger: false });
  // /v1/admin/overview 需要至少一个 Provider 才能构造概览；不需要真的连 Runner。
  return { app, context };
}

function substituteParams(url: string): string {
  return url
    .replace(":runnerId", "ghost-runner")
    .replace(":providerId", "tavily")
    .replace(":requestId", "req-1");
}

describe("admin route auth coverage", () => {
  it("classifies every registered /v1 route as cookie-session, bearer-only, or unauthenticated", async () => {
    const { app } = buildServer();
    await app.ready();
    const routes = collectRegisteredRoutes(app.printRoutes({ commonPrefix: false }));
    await app.close();

    const v1Routes = routes
      .map((route) => `${route.method} ${route.url}`)
      .filter((key) => key.includes(" /v1/"))
      .sort();

    // 路由枚举本身要正确：否则守卫会空转通过。
    expect(v1Routes).toContain("GET /v1/admin/runners/:runnerId/credentials");
    expect(v1Routes).toContain("POST /v1/providers/:providerId/usage");

    const unclassified = v1Routes.filter((key) =>
      !COOKIE_AUTH_ROUTES.has(key)
      && !UNAUTHENTICATED_ROUTES.has(key)
      && !BEARER_ONLY_ROUTES.has(key));

    expect(
      unclassified,
      "新增 /v1 路由必须显式归类：Admin 页面要用的加入 COOKIE_AUTH_ROUTES，否则加入 BEARER_ONLY_ROUTES；"
      + "漏归类正是「浏览器点击就跳登录页」的成因",
    ).toEqual([]);
  });

  it("accepts an admin session cookie on every cookie-auth route", async () => {
    const { app } = buildServer();
    const { cookie, csrfToken } = await loginAdmin(app);

    const failures: string[] = [];
    for (const key of COOKIE_AUTH_ROUTES) {
      const [method, url] = key.split(" ") as [string, string];
      const response = await app.inject({
        method: method as "GET" | "POST",
        url: substituteParams(url),
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          cookie,
          ...(method === "POST" ? { "x-csrf-token": csrfToken } : {}),
        },
        ...(method === "POST" ? { payload: {} } : {}),
      });

      // 401 表示会话鉴权没通过（白名单漏配或路由串写错）；
      // 503/409/400 等业务错误都说明鉴权已通过。
      if (response.statusCode === 401) {
        failures.push(`${key} → 401 ${response.body}`);
      }
    }

    await app.close();
    expect(failures, "这些路由拒绝管理会话 Cookie，浏览器会跳登录页").toEqual([]);
  });

  it("still rejects cookie auth where it is not allowed", async () => {
    const { app } = buildServer();
    const { cookie } = await loginAdmin(app);

    for (const key of BEARER_ONLY_ROUTES) {
      const [method, url] = key.split(" ") as [string, string];
      const response = await app.inject({
        method: method as "GET" | "POST",
        url: substituteParams(url),
        headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie },
      });
      expect(response.statusCode, `${key} 不应接受 Cookie 会话`).toBe(401);
    }

    await app.close();
  });
});
