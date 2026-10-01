import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";
import { RetrievalError, toErrorPayload } from "../../core/errors.js";
import { attachRunnerGateway } from "../../runtime/runner-gateway.js";
import { renderAdminPage, type AdminPage } from "./admin-page.js";
import { buildAdminOverview } from "./admin-data.js";

const searchSchema = z.object({
  query: z.string().min(1),
  route: z.string().min(1).optional(),
  sources: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(100).optional(),
  language: z.string().min(1).optional(),
});

export function buildHttpServer(context: GatewayContext): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: z.prettifyError(error), retryable: false },
      });
    }

    if (error instanceof RetrievalError) {
      const status = error.code === "AUTH_FAILED" ? 401 : error.code === "INVALID_REQUEST" ? 400 : 503;
      return reply.status(status).send({ error: toErrorPayload(error) });
    }

    app.log.error(error);
    return reply.status(500).send({ error: toErrorPayload(error) });
  });

  app.get("/health", async () => ({ status: "ok" }));

  const sendAdminPage = (page: AdminPage) =>
    async (_request: unknown, reply: import("fastify").FastifyReply) => {
      return reply
        .header("cache-control", "no-store")
        .header("x-frame-options", "DENY")
        .header("x-content-type-options", "nosniff")
        .header(
          "content-security-policy",
          "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        .type("text/html; charset=utf-8")
        .send(renderAdminPage(page));
    };

  app.get("/admin", sendAdminPage("overview"));
  app.get("/admin/", sendAdminPage("overview"));
  app.get("/admin/runtimes", sendAdminPage("runtimes"));
  app.get("/admin/providers", sendAdminPage("providers"));
  app.get("/admin/profiles", sendAdminPage("profiles"));
  app.get("/admin/audits", sendAdminPage("audits"));
  app.get("/admin/tester", sendAdminPage("tester"));

  app.get("/ready", async () => ({
    status: "ready",
    runtimes: context.runtimes.list().length,
  }));

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/v1/") || request.url === context.config.server.runnerPath) return;
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${context.config.auth.apiKey}`) {
      throw new RetrievalError("AUTH_FAILED", "Invalid API key");
    }
  });

  app.post("/v1/search", async (request) => {
    return context.search.search(searchSchema.parse(request.body));
  });

  app.get("/v1/providers", async () => ({
    providers: context.providers.list().map(({ id, config }) => ({
      id,
      type: config.type,
      enabled: config.enabled,
      runtime: config.runtime,
    })),
  }));

  app.post<{ Params: { providerId: string } }>("/v1/providers/:providerId/auth/check", async (request) => {
    const result = await context.dispatcher.auth(request.params.providerId, "check");
    return { providerId: request.params.providerId, runtimeId: result.runtimeId, auth: result.output };
  });

  app.post<{ Params: { providerId: string } }>("/v1/providers/:providerId/auth/login", async (request) => {
    const result = await context.dispatcher.auth(request.params.providerId, "login");
    return { providerId: request.params.providerId, runtimeId: result.runtimeId, auth: result.output };
  });

  // 节点列表只展示真实且已连接的 Runner；Gateway 不是可调度节点，也不会把自己注册成 Runtime。
  app.get("/v1/runtimes", async () => ({
    runtimes: context.runtimes.list(),
  }));

  app.get("/v1/admin/overview", async () => buildAdminOverview(context));

  app.get<{ Params: { requestId: string } }>("/v1/audit/:requestId", async (request, reply) => {
    const record = context.audit.get(request.params.requestId);
    if (!record) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Audit record not found" } });
    return record;
  });

  attachRunnerGateway({
    app,
    path: context.config.server.runnerPath,
    tokens: context.config.auth.runnerTokens,
    heartbeatTimeoutMs: context.config.runtimeRegistry.heartbeatTimeoutMs,
    runtimes: context.runtimes,
    sessions: context.runnerSessions,
  });

  return app;
}
