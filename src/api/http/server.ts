import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";
import { RetrievalError, toErrorPayload } from "../../core/errors.js";
import { attachRunnerGateway } from "../../runtime/runner-gateway.js";

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

  app.get("/ready", async () => ({
    status: "ready",
    localRuntime: "online",
    remoteRuntimes: context.runtimes.list().filter((runtime) => runtime.id !== "local").length,
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

  app.get("/v1/runtimes", async () => ({ runtimes: context.runtimes.list() }));

  app.get<{ Params: { requestId: string } }>("/v1/audit/:requestId", async (request, reply) => {
    const record = context.audit.get(request.params.requestId);
    if (!record) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Audit record not found" } });
    return record;
  });

  app.get("/v1/browser-profiles", async () => ({
    profiles: context.browserProfiles.list().map(({ userDataDir: _userDataDir, ...profile }) => profile),
  }));

  app.addHook("onClose", async () => {
    await context.browser.close();
  });

  attachRunnerGateway({
    app,
    path: context.config.server.runnerPath,
    tokens: context.config.auth.runnerTokens,
    runtimes: context.runtimes,
    sessions: context.runnerSessions,
  });

  return app;
}
