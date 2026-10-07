import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { GatewayContext } from "../../app/context.js";
import type { AdminSessionStore } from "./admin-session.js";

export class AdminHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 429 | 503,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AdminHttpError";
  }
}

export function safeTokenEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function expectedOrigin(request: FastifyRequest, context: GatewayContext): string | undefined {
  if (context.config.server.publicOrigin) return context.config.server.publicOrigin;
  const host = request.headers.host;
  if (!host || /[\s,]/.test(host)) return undefined;
  try {
    return new URL(`${request.protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function assertSameOrigin(request: FastifyRequest, context: GatewayContext): void {
  const origin = request.headers.origin;
  const expected = expectedOrigin(request, context);
  if (!origin || origin === "null" || !expected || origin !== expected) {
    throw new AdminHttpError(403, "ADMIN_ORIGIN_REJECTED", "Request origin is not allowed");
  }
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1") return true;
  const family = isIP(address);
  return family === 4 && address.split(".")[0] === "127";
}

export function requestIsSecureOrLocal(request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  try {
    const host = request.headers.host;
    const hostname = host ? new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "") : "";
    return (hostname === "localhost" || hostname.endsWith(".localhost") || isLoopback(hostname)) && isLoopback(request.ip);
  } catch {
    return false;
  }
}

export function assertCsrf(request: FastifyRequest, token: string | undefined): void {
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || !token || !safeTokenEqual(token, supplied)) {
    throw new AdminHttpError(403, "ADMIN_CSRF_REJECTED", "CSRF token is missing or invalid");
  }
}

export function getSessionId(request: FastifyRequest): string | undefined {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.["aylens.admin.session"];
}

const COOKIE_AUTH_ROUTES = new Set([
  "GET /v1/admin/overview",
  "POST /v1/search",
  "POST /v1/providers/:providerId/auth/login",
  "POST /v1/providers/:providerId/auth/check",
]);

export function authenticateAdminOrBearer(
  request: FastifyRequest,
  context: GatewayContext,
  sessions: AdminSessionStore,
): void {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    if (authorization !== `Bearer ${context.config.auth.apiKey}`) {
      throw new AdminHttpError(401, "AUTH_FAILED", "Invalid API key");
    }
    return;
  }

  const route = request.routeOptions.url;
  const method = request.method.toUpperCase();
  if (!route || !COOKIE_AUTH_ROUTES.has(`${method} ${route}`)) {
    throw new AdminHttpError(401, "AUTH_FAILED", "Invalid API key");
  }

  const sessionId = getSessionId(request);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) throw new AdminHttpError(401, "AUTH_FAILED", "Admin session is missing or expired");

  if (method !== "GET") {
    assertSameOrigin(request, context);
    assertCsrf(request, session.csrfToken);
  }
}
