import { z } from "zod";
import type { CredentialWrite as CredentialWriteDomain } from "../runner/credentials/service.js";
import type { SafeCredentialConfig } from "../runner/credentials/types.js";

/**
 * 凭据配置的线上传输契约。
 *
 * 与代理配置同一套管理语义：expectedVersion 防并发覆盖、operationId 关联回执，
 * 写入内容只允许白名单字段——任何 raw secret 之外的透传都必须在此被 schema 剥掉。
 * 见 docs/adr/2026-10-09-runner-api-credential-management.md。
 */

export const credentialMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("put-pool"),
    id: z.string().min(1),
    service: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
  }),
  z.object({ kind: z.literal("delete-pool"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("put-credential"),
    id: z.string().min(1),
    poolId: z.string().min(1),
    name: z.string().min(1),
    // secret 可省略 = 保留已存值；不能用脱敏占位符充当真实凭据。
    secret: z.string().min(1).max(4_096).optional(),
    enabled: z.boolean(),
    accountGroup: z.string().min(1).max(200).optional(),
  }),
  z.object({ kind: z.literal("delete-credential"), id: z.string().min(1) }),
  z.object({ kind: z.literal("set-pool-enabled"), id: z.string().min(1), enabled: z.boolean() }),
  z.object({ kind: z.literal("set-credential-enabled"), id: z.string().min(1), enabled: z.boolean() }),
  z.object({ kind: z.literal("clear-state"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("bind"),
    providerId: z.string().min(1),
    poolId: z.string().min(1).nullable(),
  }),
]);

export const credentialWriteSchema = z.object({
  operationId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  mutation: credentialMutationSchema,
});

export type CredentialMutation = z.infer<typeof credentialMutationSchema>;
export type CredentialWrite = CredentialWriteDomain;

const availabilitySchema = z.enum([
  "available",
  "cooling",
  "auth_failed",
  "quota_blocked",
  "disabled",
  "unknown",
]);

const failureCategorySchema = z.enum([
  "invalid_request",
  "auth",
  "permission",
  "rate_limited",
  "quota",
  "network",
  "upstream",
  "item_content",
]);

/**
 * 安全视图：**唯一**允许离开 Runner 的凭据形态。
 * 刻意不含 secret / secret_hash —— 少一个字段比漏一个字段安全。
 */
export const safeCredentialConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  lastOperationId: z.string().optional(),
  pools: z.array(z.object({
    id: z.string(),
    service: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    credentialCount: z.number().int().nonnegative(),
    providerRefs: z.array(z.string()),
  })),
  credentials: z.array(z.object({
    id: z.string(),
    poolId: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    accountGroup: z.string().optional(),
    maskedSecret: z.string(),
    availability: availabilitySchema,
    cooldownUntil: z.number().optional(),
    lastFailureCategory: failureCategorySchema.optional(),
    lastSuccessAt: z.number().optional(),
  })),
  providers: z.array(z.object({
    id: z.string(),
    poolId: z.string().nullable(),
    /**
     * 该 Provider 的服务类型（供界面只展示匹配的池）。
     * 可选：Store 的纯 DB 视图没有配置知识，只有 Service 视图会填；
     * 缺失时界面退回“展示全部池”，不假装知道。
     */
    service: z.string().optional(),
  })),
});

export type SafeCredentialConfigWire = z.infer<typeof safeCredentialConfigSchema>;

/** 供操作审计表使用的安全目标标识（池或凭据 ID），绝不含 secret。 */
export function credentialOperationTarget(mutation: CredentialMutation): string {
  if (mutation.kind === "bind") return mutation.providerId;
  if (mutation.kind === "put-pool" || mutation.kind === "delete-pool" || mutation.kind === "set-pool-enabled") {
    return mutation.id;
  }
  if (mutation.kind === "put-credential" || mutation.kind === "delete-credential"
    || mutation.kind === "set-credential-enabled" || mutation.kind === "clear-state") {
    return mutation.id;
  }
  return "credential";
}

export type { SafeCredentialConfig };
