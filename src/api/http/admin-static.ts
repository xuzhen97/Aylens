import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";

const ADMIN_PAGES = [
  "/admin",
  "/admin/",
  "/admin/login",
  "/admin/runtimes",
  "/admin/providers",
  "/admin/profiles",
  "/admin/proxies",
  // API 凭据管理页。这份白名单与前端路由是两份独立真相源，
  // 漏加只会表现为 404（无编译或测试信号），两侧必须同步。
  "/admin/credentials",
  "/admin/audits",
  "/admin/tester",
] as const;

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
} as const;

function addSecurityHeaders(reply: FastifyReply): FastifyReply {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  return reply;
}


/** Resolve the frontend build beside a release bundle, or from the source tree in development. */
export function resolveAdminStaticRoot(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const releaseRoot = join(moduleDir, "admin");
  if (existsSync(join(releaseRoot, "index.html"))) return resolve(releaseRoot);
  const sourceRoot = resolve(moduleDir, "../../../apps/admin/dist");
  if (existsSync(join(sourceRoot, "index.html"))) return sourceRoot;
  return releaseRoot;
}

export function registerAdminStatic(app: FastifyInstance, options: { root: string }): void {
  const root = resolve(options.root);
  const indexFile = join(root, "index.html");
  const assetsRoot = join(root, "assets");
  const available = existsSync(indexFile);

  if (existsSync(assetsRoot)) {
    void app.register(fastifyStatic, {
      root: assetsRoot,
      prefix: "/admin/assets/",
      wildcard: true,
      decorateReply: false,
      dotfiles: "deny",
      allowedPath: (pathName) => !pathName.split("/").some((part) => part.startsWith(".")),
      setHeaders(reply, pathName) {
        addSecurityHeaders(reply);
        if (/[-.][a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(pathName)) {
          reply.header("cache-control", "public, max-age=31536000, immutable");
        } else {
          reply.header("cache-control", "public, max-age=3600");
        }
      },
    });
  } else {
    app.get("/admin/assets/*", async (_request, reply) => {
      return addSecurityHeaders(reply).header("cache-control", "no-store").status(available ? 404 : 503).send({
        error: { code: available ? "NOT_FOUND" : "ADMIN_UNAVAILABLE", message: available ? "Asset not found" : "Admin frontend is not built" },
      });
    });
  }

  for (const route of ADMIN_PAGES) {
    app.get(route, async (_request, reply) => {
      if (!available) {
        return addSecurityHeaders(reply).header("cache-control", "no-store").status(503).type("text/plain; charset=utf-8").send("Admin frontend is not built");
      }
      return addSecurityHeaders(reply)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(await readFile(indexFile));
    });
  }
}
