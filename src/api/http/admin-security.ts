import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { GatewayContext } from "../../app/context.js";
import type { AdminSessionStore } from "./admin-session.js";

export class AdminHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 429 | 503,
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

/**
 * 允许用管理会话 Cookie（而非 Bearer Key）鉴权的路由。
 *
 * 存在的意义：给 Admin 页面用，同时避免把 Cookie 凭据暴露给公共 API 面。
 * 但它是**与路由注册分离的白名单**，漏加只会表现为浏览器访问 401→跳登录页
 * （Bearer 调用不受影响，所以单测用 Bearer 时根本不会暴露）。
 * `test/admin-route-auth-coverage.test.ts` 会枚举已注册路由，
 * 未归类的 /v1 路由会让测试失败，把静默故障变成响亮失败。
 */
export const COOKIE_AUTH_ROUTES = new Set([
  "GET /v1/admin/overview",
  "POST /v1/search",
  "POST /v1/providers/:providerId/auth/login",
  "POST /v1/providers/:providerId/auth/check",
  // 用量查询：Admin「API 凭据」页会调用，必须允许 Cookie 会话。
  "POST /v1/providers/:providerId/usage",
  // Provider 启用态写入：Admin「Providers」页发起，必须允许 Cookie 会话。
  // 漏加的表现是浏览器点击 401 跳登录页，而 Bearer 单测全绿。
  "POST /v1/providers/:providerId/enabled",
  "GET /v1/admin/runners/:runnerId/proxy-config",
  "POST /v1/admin/runners/:runnerId/proxy-config",
  // API 凭据管理：与代理配置同级，同样由 Admin 页发起。
  "GET /v1/admin/runners/:runnerId/credentials",
  "POST /v1/admin/runners/:runnerId/credentials",
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
