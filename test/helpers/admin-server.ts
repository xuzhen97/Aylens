import type { FastifyInstance } from "fastify";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach } from "vitest";
import { appConfigSchema } from "../../src/config/schema.js";
import { createGatewayContext } from "../../src/app/context.js";
import { buildHttpServer } from "../../src/api/http/server.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

export function createAdminTestServer(overrides: {
  apiKey?: string;
  publicOrigin?: string;
  trustProxy?: string[];
  /** 需要派发到 Provider 的测试用：缺省仍为 {}，不影响既有用例。 */
  providers?: Record<string, { type: string; enabled?: boolean }>;
  routes?: Record<string, { providers: string[] }>;
} = {}) {
  const config = appConfigSchema.parse({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 3000,
      runnerPath: "/v1/runners/connect",
      publicOrigin: overrides.publicOrigin ?? "http://localhost:3000",
      trustProxy: overrides.trustProxy ?? [],
    },
    auth: { apiKey: overrides.apiKey ?? "admin-test-key", runnerTokens: {} },
    runtimeRegistry: { heartbeatTimeoutMs: 1000, offlineAfterMs: 5000, jobTimeoutMs: 1000 },
    providers: overrides.providers ?? {},
    routes: overrides.routes ?? { default: { providers: [] } },
  });
  const context = createGatewayContext(config);
  const app = buildHttpServer(context, {
    logger: false,
    adminStaticRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/admin/dist"),
  });
  apps.push(app);
  return { app, context };
}

export async function loginAdmin(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/session/login",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
    payload: { apiKey: "admin-test-key" },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Admin login failed (${response.statusCode}): ${response.body}`);
  }
  const setCookie = response.headers["set-cookie"];
  if (typeof setCookie !== "string") throw new Error(`Admin login did not set a cookie: ${response.body}`);
  const cookie = setCookie.split(";", 1)[0]!;
  const payload = response.json() as { csrfToken: string; expiresAt: number };
  return { response, cookie, csrfToken: payload.csrfToken, expiresAt: payload.expiresAt };
}
