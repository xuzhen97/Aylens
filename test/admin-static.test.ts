import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { resolveAdminStaticRoot } from "../src/api/http/admin-static.js";

let app: FastifyInstance | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function fixture() {
  tempRoot = await mkdtemp(join(tmpdir(), "aylens-admin-static-"));
  await mkdir(join(tempRoot, "assets"), { recursive: true });
  await writeFile(join(tempRoot, "index.html"), '<!doctype html><html><head><script type="module" src="/admin/assets/main-12345678.js"></script></head></html>');
  await writeFile(join(tempRoot, "assets", "main-12345678.js"), "console.log('admin')");
  await writeFile(join(tempRoot, "assets", "main.css"), "body{color:black}");
  const config = appConfigSchema.parse({ version: 1, auth: { apiKey: "test", runnerTokens: {} } });
  app = buildHttpServer(createGatewayContext(config), { logger: false, adminStaticRoot: tempRoot });
  return app;
}

describe("admin static hosting", () => {
  it("serves the SPA for known deep links with a strict CSP", async () => {
    const server = await fixture();
    for (const url of ["/admin", "/admin/", "/admin/login", "/admin/profiles", "/admin/tester"]) {
      const response = await server.inject(url);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("style-src 'self'");
      expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
    }
  });

  it("serves assets with content types and immutable cache only for hashed files", async () => {
    const server = await fixture();
    const js = await server.inject("/admin/assets/main-12345678.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toContain("immutable");
    const css = await server.inject("/admin/assets/main.css");
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.headers["cache-control"]).not.toContain("immutable");
    expect((await server.inject("/admin/assets/missing.js")).statusCode).toBe(404);
  });

  it("does not turn unknown pages, missing assets, or APIs into the SPA", async () => {
    const server = await fixture();
    expect((await server.inject("/admin/unknown")).statusCode).toBe(404);
    expect((await server.inject("/v1/missing")).body).not.toContain("<html");
    expect((await server.inject("/health")).statusCode).toBe(200);
  });

  it("returns a clear unavailable response when the frontend build is absent", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aylens-admin-empty-"));
    const config = appConfigSchema.parse({ version: 1, auth: { apiKey: "test", runnerTokens: {} } });
    app = buildHttpServer(createGatewayContext(config), { logger: false, adminStaticRoot: tempRoot });
    expect((await app.inject("/admin")).statusCode).toBe(503);
    expect((await app.inject("/health")).statusCode).toBe(200);
  });

  it("resolves source and release roots from module URLs", () => {
    const source = new URL("../src/api/http/admin-static.ts", import.meta.url).href;
    const release = new URL("../release/gateway/aylens-gateway.mjs", import.meta.url).href;
    expect(resolveAdminStaticRoot(source).replaceAll("\\", "/")).toContain("apps/admin/dist");
    expect(resolveAdminStaticRoot(release).replaceAll("\\", "/")).toContain("release/gateway/admin");
  });
});
