import { z } from "zod";

const httpProxyUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "HTTP proxy URL must use http:// or https://");

const socks5UrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "socks5:" || protocol === "socks5h:";
}, "SOCKS5 proxy URL must use socks5:// or socks5h://");

export const transportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("direct") }),
  z.object({ type: z.literal("http-proxy"), url: httpProxyUrlSchema }),
  z.object({ type: z.literal("socks5"), url: socks5UrlSchema }),
]);

const runtimeSelectorSchema = z.object({
  os: z.enum(["windows", "linux", "darwin"]).optional(),
  providerType: z.string().min(1).optional(),
  browser: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const providerRuntimeSchema = z.union([
  z.object({ nodeId: z.string().min(1) }),
  z.object({ selector: runtimeSelectorSchema }),
]);

export const providerSchema = z.object({
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  // Gateway-owned logical definition: only placement belongs here.
  runtime: providerRuntimeSchema,
});

export const providerDeploymentSchema = z.object({
  type: z.string().min(1),
  transport: z.object({
    primary: z.string().min(1),
    fallback: z.array(z.string().min(1)).default([]),
  }).optional(),
  browser: z.object({ profile: z.string().min(1) }).optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const browserProfileSchema = z.object({
  browser: z.literal("chrome").default("chrome"),
  mode: z.enum(["launch", "cdp"]).default("launch"),
  persistent: z.literal(true).default(true),
  userDataDir: z.string().min(1),
  maxConcurrency: z.number().int().positive().default(1),
  interactive: z.boolean().default(false),
  headless: z.boolean().default(false),
  channel: z.string().min(1).default("chrome"),
  executablePath: z.string().min(1).optional(),
  cdpEndpoint: z.string().url().optional(),
  args: z.array(z.string()).default([]),
  transport: z.string().min(1).optional(),
});

export const appConfigSchema = z.object({
  version: z.literal(1),
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(3000),
    runnerPath: z.string().startsWith("/").default("/v1/runners/connect"),
  }),
  auth: z.object({
    apiKey: z.string().min(1),
    runnerTokens: z.record(z.string(), z.string().min(1)).default({}),
  }),
  runtimeRegistry: z.object({
    heartbeatTimeoutMs: z.number().int().positive().default(30_000),
    offlineAfterMs: z.number().int().positive().default(60_000),
    jobTimeoutMs: z.number().int().positive().default(30_000),
  }),
  providers: z.record(z.string(), providerSchema).default({}),
  routes: z.record(z.string(), z.object({
    providers: z.array(z.string()).default([]),
  })).default({ default: { providers: [] } }),
}).superRefine((config, ctx) => {
  for (const [routeId, route] of Object.entries(config.routes)) {
    for (const providerId of route.providers) {
      if (!(providerId in config.providers)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes", routeId, "providers"],
          message: `Unknown provider: ${providerId}`,
        });
      }
    }
  }

});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type TransportConfig = z.infer<typeof transportSchema>;
export type BrowserProfileConfig = z.infer<typeof browserProfileSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ProviderDeploymentConfig = z.infer<typeof providerDeploymentSchema>;
export type RuntimeSelectorConfig = z.infer<typeof runtimeSelectorSchema>;
