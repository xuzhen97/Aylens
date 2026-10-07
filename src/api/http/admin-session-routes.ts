import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayContext } from "../../app/context.js";
import { AdminSessionCapacityError, type AdminSessionStore, type LoginLimiter } from "./admin-session.js";
import { AdminHttpError, assertCsrf, assertSameOrigin, requestIsSecureOrLocal, safeTokenEqual } from "./admin-security.js";

const SESSION_COOKIE = "aylens.admin.session";
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

type SessionRoutesOptions = {
  app: FastifyInstance;
  context: GatewayContext;
  sessions: AdminSessionStore;
  limiter: LoginLimiter;
};

function sendError(reply: FastifyReply, error: AdminHttpError): FastifyReply {
  reply.header("cache-control", "no-store");
  if (error.retryAfterSeconds !== undefined) reply.header("retry-after", String(error.retryAfterSeconds));
  return reply.status(error.statusCode).send({
    error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
  });
}

function cookieOptions(request: FastifyRequest, expires?: Date) {
  return {
    path: "/v1",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: request.protocol === "https",
    ...(expires ? { expires } : {}),
  };
}

function parseLoginKey(request: FastifyRequest): string {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new AdminHttpError(400, "INVALID_REQUEST", "Login requires a JSON body");
  }
  const length = Number(request.headers["content-length"] ?? Buffer.byteLength(JSON.stringify(request.body)));
  if (length > MAX_LOGIN_BODY_BYTES) throw new AdminHttpError(400, "INVALID_REQUEST", "Login body is too large");
  const body = request.body;
  if (!body || typeof body !== "object" || typeof (body as { apiKey?: unknown }).apiKey !== "string" ||
    !(body as { apiKey: string }).apiKey) {
    throw new AdminHttpError(400, "INVALID_REQUEST", "A non-empty apiKey is required");
  }
  return (body as { apiKey: string }).apiKey;
}

export function registerAdminSessionRoutes(options: SessionRoutesOptions): void {
  const { app, context, sessions, limiter } = options;

  app.post("/v1/admin/session/login", async (request, reply) => {
    try {
      assertSameOrigin(request, context);
      if (!requestIsSecureOrLocal(request)) {
        throw new AdminHttpError(403, "HTTPS_REQUIRED", "HTTPS is required outside loopback development");
      }
      const address = request.ip;
      const limit = limiter.consume(address);
      if (!limit.allowed) {
        throw new AdminHttpError(429, "RATE_LIMITED", "Too many login attempts", limit.retryAfterSeconds);
      }
      const apiKey = parseLoginKey(request);
      if (!safeTokenEqual(context.config.auth.apiKey, apiKey)) throw new AdminHttpError(401, "AUTH_FAILED", "Invalid API key");
      const oldId = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
      const session = sessions.create(typeof oldId === "string" ? oldId : undefined);
      reply.header("cache-control", "no-store");
      (reply as FastifyReply & { setCookie(name: string, value: string, options: ReturnType<typeof cookieOptions>): FastifyReply })
        .setCookie(SESSION_COOKIE, session.id, cookieOptions(request, new Date(session.expiresAt)));
      return reply.status(200).send({ authenticated: true, expiresAt: session.expiresAt, csrfToken: session.csrfToken });
    } catch (error) {
      if (error instanceof AdminHttpError) return sendError(reply, error);
      if (error instanceof AdminSessionCapacityError) {
        return sendError(reply, new AdminHttpError(503, "ADMIN_SESSION_CAPACITY", "Admin session capacity reached"));
      }
      throw error;
    }
  });

  app.get("/v1/admin/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const id = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    if (!session) return sendError(reply, new AdminHttpError(401, "AUTH_FAILED", "Admin session is missing or expired"));
    return { authenticated: true, expiresAt: session.expiresAt, csrfToken: session.csrfToken };
  });

  app.post("/v1/admin/session/logout", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      assertSameOrigin(request, context);
      const id = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
      const session = typeof id === "string" ? sessions.get(id) : undefined;
      if (session) assertCsrf(request, session.csrfToken);
      if (typeof id === "string") sessions.revoke(id);
      (reply as FastifyReply & { clearCookie(name: string, options: ReturnType<typeof cookieOptions>): FastifyReply })
        .clearCookie(SESSION_COOKIE, cookieOptions(request));
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof AdminHttpError) return sendError(reply, error);
      throw error;
    }
  });
}
