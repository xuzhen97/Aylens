import { z } from "zod";

/** Provider 的传输绑定:主代理与有序备用代理;null 表示显式无绑定。 */
export const providerTransportBindingSchema = z.object({
  primary: z.string().min(1),
  fallback: z.array(z.string().min(1)).default([]),
});

export type ProviderTransportBinding = z.infer<typeof providerTransportBindingSchema>;

export const credentialChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }),
  z.object({ action: z.literal("clear") }),
  z.object({
    action: z.literal("replace"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
]);

export type CredentialChange = z.infer<typeof credentialChangeSchema>;

/**
 * 代理地址必须是无 userinfo 的 endpoint:
 * 仅允许 http/https/socks5/socks5h 协议、host/port,路径只能为空或 `/`,无 query/fragment。
 */
export const proxyAddressSchema = z.string().min(1).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Proxy address is not a valid URL" });
    return;
  }

  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) {
    ctx.addIssue({ code: "custom", message: "Proxy protocol must be http, https, socks5 or socks5h" });
    return;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: "custom", message: "Proxy address must not embed credentials" });
    return;
  }
  if (!url.hostname) {
    ctx.addIssue({ code: "custom", message: "Proxy address requires a host" });
    return;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    ctx.addIssue({ code: "custom", message: "Proxy address must not include a path" });
    return;
  }
  if (url.search || url.hash) {
    ctx.addIssue({ code: "custom", message: "Proxy address must not include query or fragment" });
  }
});

export const proxyMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("put"),
    id: z.string().min(1).refine((id) => id !== "direct", "direct transport is immutable"),
    type: z.union([z.literal("http-proxy"), z.literal("socks5")]),
    address: proxyAddressSchema,
    credentials: credentialChangeSchema,
  }),
  z.object({
    kind: z.literal("delete"),
    id: z.string().min(1).refine((id) => id !== "direct", "direct transport cannot be deleted"),
  }),
  z.object({
    kind: z.literal("bind"),
    providerId: z.string().min(1),
    binding: providerTransportBindingSchema.nullable(),
  }),
]);

export type ProxyMutation = z.infer<typeof proxyMutationSchema>;

export const proxyWriteSchema = z.object({
  operationId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  mutation: proxyMutationSchema,
});

export type ProxyWrite = z.infer<typeof proxyWriteSchema>;

/** Runner 内部完整状态:含私密 URL,绝不直接返回给 Gateway 或 Admin。 */
export interface ProxyConfigState {
  version: number;
  initialized: boolean;
  transports: Record<string, { type: "direct" } | { type: "http-proxy" | "socks5"; url: string }>;
  bindings: Record<string, ProviderTransportBinding | null>;
  lastOperationId?: string;
}

/** 安全视图:只含脱敏字段,凭据不可恢复。 */
export const safeProxyConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  lastOperationId: z.string().optional(),
  proxies: z.array(z.object({
    id: z.string(),
    type: z.enum(["direct", "http-proxy", "socks5"]),
    address: z.string().optional(),
    hasCredentials: z.boolean(),
    providerRefs: z.array(z.string()),
    profileRefs: z.array(z.string()),
  })),
  providers: z.array(z.object({
    id: z.string(),
    binding: providerTransportBindingSchema.nullable(),
  })),
  browserRestartRequired: z.array(z.string()),
});

export type SafeProxyConfig = z.infer<typeof safeProxyConfigSchema>;
