import { afterEach, describe, expect, it } from "vitest";
import { createAdminTestServer, loginAdmin } from "./helpers/admin-server.js";

const origin = "http://localhost:3000";

describe("Admin session authentication", () => {
  afterEach(() => undefined);

  it("validates the existing key and applies the Cookie allowlist without Bearer fallback", async () => {
    const { app } = createAdminTestServer();
    const login = await loginAdmin(app);
    expect(login.response.statusCode).toBe(200);
    expect(login.response.headers["cache-control"]).toBe("no-store");
    expect(login.cookie).toContain("aylens.admin.session=");
    expect(login.response.body).not.toContain("admin-test-key");

    const headers = { cookie: login.cookie, host: "localhost:3000" };
    expect((await app.inject({ method: "GET", url: "/v1/admin/overview", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/providers", headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/admin/overview", headers: {
      ...headers,
      authorization: "Bearer wrong",
    } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/session/login", headers: {
      host: "localhost:3000", origin, "content-type": "application/json",
    }, payload: { apiKey: "wrong" } })).statusCode).toBe(401);
    await app.close();
  });

  it("requires same-origin and a session CSRF token for cookie-authenticated writes", async () => {
    const { app } = createAdminTestServer();
    const login = await loginAdmin(app);
    const headers = { cookie: login.cookie, host: "localhost:3000", origin, "content-type": "application/json" };

    const denied = await app.inject({ method: "POST", url: "/v1/search", headers, payload: { query: "hello" } });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "POST", url: "/v1/search", headers: {
      ...headers, "x-csrf-token": login.csrfToken,
    }, payload: { query: "hello" } });
    expect(allowed.statusCode).toBe(200); // Auth passed and the real SearchService returns a completed empty result.

    const crossSite = await app.inject({ method: "POST", url: "/v1/search", headers: {
      ...headers, origin: "https://attacker.example", "x-csrf-token": login.csrfToken,
    }, payload: { query: "hello" } });
    expect(crossSite.statusCode).toBe(403);
    await app.close();
  });

  it("supports session probe and idempotent same-origin logout", async () => {
    const { app } = createAdminTestServer();
    const login = await loginAdmin(app);
    const probe = await app.inject({ method: "GET", url: "/v1/admin/session", headers: { cookie: login.cookie } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ authenticated: true, csrfToken: login.csrfToken });
    expect(probe.body).not.toContain(login.cookie.split("=", 2)[1]);

    const logout = await app.inject({ method: "POST", url: "/v1/admin/session/logout", headers: {
      cookie: login.cookie, host: "localhost:3000", origin, "x-csrf-token": login.csrfToken,
    } });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/admin/session", headers: { cookie: login.cookie } })).statusCode)
      .toBe(401);
    await app.close();
  });
});
