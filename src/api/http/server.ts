import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";
import { RetrievalError, toErrorPayload } from "../../core/errors.js";
import { attachRunnerGateway } from "../../runtime/runner-gateway.js";
import { registerAdminStatic, resolveAdminStaticRoot } from "./admin-static.js";
import { buildAdminOverview } from "./admin-data.js";
import { AdminHttpError, authenticateAdminOrBearer } from "./admin-security.js";
import { AdminSessionStore, LoginLimiter } from "./admin-session.js";
import { registerAdminSessionRoutes } from "./admin-session-routes.js";
import { registerRunnerProxyRoutes } from "./runner-proxy-routes.js";
import { registerRunnerCredentialRoutes } from "./runner-credential-routes.js";
import { extractRequestSchema, searchRequestSchema } from "../../contracts/validation.js";

export function buildHttpServer(context: GatewayContext, options: Pick<FastifyServerOptions, "logger"> & { adminStaticRoot?: string } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-csrf-token", "res.headers.set-cookie", "req.body.apiKey"],
        censor: "[Redacted]",
      },
    },
    trustProxy: context.config.server.trustProxy.length > 0 ? context.config.server.trustProxy : false,
    bodyLimit: 1024 * 1024,
  });
  const sessions = new AdminSessionStore({ getApiKey: () => context.config.auth.apiKey });
  const loginLimiter = new LoginLimiter();

  void app.register(cookie);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdminHttpError) {
      reply.header("cache-control", "no-store");
      if (error.retryAfterSeconds !== undefined) reply.header("retry-after", String(error.retryAfterSeconds));
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
      });
    }

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

  registerAdminStatic(app, { root: options.adminStaticRoot ?? resolveAdminStaticRoot(import.meta.url) });


  app.get("/ready", async () => ({
    status: "ready",
    runtimes: context.runtimes.list().length,
  }));

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/v1/") || request.url === context.config.server.runnerPath) return;
    const route = request.routeOptions.url;
    if (route === "/v1/admin/session/login" || route === "/v1/admin/session" || route === "/v1/admin/session/logout") return;
    authenticateAdminOrBearer(request, context, sessions);
  });

  registerAdminSessionRoutes({ app, context, sessions, limiter: loginLimiter });
  app.get("/v1/admin/overview", async () => buildAdminOverview(context));

  app.post("/v1/search", async (request) => {
    return context.search.search(searchRequestSchema.parse(request.body));
  });

  // 独立的 Extract 能力:必须显式给出 sources,不与 search 共用路由默认值。
  app.post("/v1/extract", async (request) => {
    return context.extract.extract(extractRequestSchema.parse(request.body));
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

  // 用量查询：可选管理能力，未声明该能力的 Provider 返回明确错误，而不是空报告。
  app.post<{ Params: { providerId: string } }>("/v1/providers/:providerId/usage", async (request) => {
    const result = await context.dispatcher.usage(request.params.providerId);
    return { providerId: request.params.providerId, runtimeId: result.runtimeId, usage: result.output };
  });

  app.post<{ Params: { providerId: string } }>("/v1/providers/:providerId/auth/login", async (request) => {
    const result = await context.dispatcher.auth(request.params.providerId, "login");
    return { providerId: request.params.providerId, runtimeId: result.runtimeId, auth: result.output };
  });

  // 节点列表只展示真实且已连接的 Runner；Gateway 不是可调度节点，也不会把自己注册成 Runtime。
  app.get("/v1/runtimes", async () => ({
    runtimes: context.runtimes.list(),
  }));

  app.get<{ Params: { requestId: string } }>("/v1/audit/:requestId", async (request, reply) => {
    const record = context.audit.get(request.params.requestId);
    if (!record) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Audit record not found" } });
    return record;
  });

  // Runner 代理配置管理:GET/POST 均走管理认证;写操作要求安全或本机连接。
  registerRunnerProxyRoutes(app, context);
  // API 凭据池管理:与代理共用配置通道,但资源类型、能力声明与审计目标独立。
  registerRunnerCredentialRoutes(app, context);

  app.addHook("onClose", async () => {
    sessions.clear();
    // HTTP 服务关闭时释放 Gateway 持久化资源(SQLite 句柄、清理定时器)。
    context.close();
  });

  attachRunnerGateway({
    app,
    path: context.config.server.runnerPath,
    tokens: context.config.auth.runnerTokens,
    heartbeatTimeoutMs: context.config.runtimeRegistry.heartbeatTimeoutMs,
    runtimes: context.runtimes,
    sessions: context.runnerSessions,
    // 必须透传配置通道,否则 Runner socket 不会 attach,代理配置读取恒为 RUNTIME_OFFLINE。
    configChannel: context.configChannel,
  });

  return app;
}
