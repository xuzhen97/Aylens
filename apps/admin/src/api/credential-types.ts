/**
 * Admin 前端 API 凭据 DTO：独立定义，不导入服务端运行模块。
 * 与 Gateway SafeCredentialConfig / CredentialWrite 契约保持字段一致。
 *
 * 刻意不含 secret —— 明文只在写入时出现，读取永远只有 maskedSecret。
 */

export type CredentialAvailability =
  | "available"
  | "cooling"
  | "auth_failed"
  | "quota_blocked"
  | "disabled"
  | "unknown";

export type CredentialFailureCategory =
  | "invalid_request"
  | "auth"
  | "permission"
  | "rate_limited"
  | "quota"
  | "network"
  | "upstream"
  | "item_content";

export type CredentialPoolSummary = {
  id: string;
  service: string;
  name: string;
  enabled: boolean;
  credentialCount: number;
  providerRefs: string[];
};

export type CredentialSummary = {
  id: string;
  poolId: string;
  name: string;
  enabled: boolean;
  accountGroup?: string;
  maskedSecret: string;
  availability: CredentialAvailability;
  cooldownUntil?: number;
  lastFailureCategory?: CredentialFailureCategory;
  lastSuccessAt?: number;
};

export type SafeCredentialConfig = {
  version: number;
  lastOperationId?: string;
  pools: CredentialPoolSummary[];
  credentials: CredentialSummary[];
  providers: Array<{ id: string; poolId: string | null; service?: string }>;
};

export type CredentialMutation =
  | { kind: "put-pool"; id: string; service: string; name: string; enabled: boolean }
  | { kind: "delete-pool"; id: string }
  | {
    kind: "put-credential";
    id: string;
    poolId: string;
    name: string;
    secret?: string;
    enabled: boolean;
    accountGroup?: string;
  }
  | { kind: "delete-credential"; id: string }
  | { kind: "set-pool-enabled"; id: string; enabled: boolean }
  | { kind: "set-credential-enabled"; id: string; enabled: boolean }
  | { kind: "clear-state"; id: string }
  | { kind: "bind"; providerId: string; poolId: string | null };

export type CredentialWrite = {
  operationId: string;
  expectedVersion: number;
  mutation: CredentialMutation;
};

/**
 * 用量报告。accuracy 区分数据来源：未知不能显示成 0，估算不是账单，
 * 不同服务商的单位（credits / requests / USD）不可直接比较。
 */
export type ProviderUsageReport = {
  service: string;
  fetchedAt: number;
  accuracy: "official" | "response" | "estimated" | "unknown";
  supported: boolean;
  entries: Array<{
    scope: "credential" | "account";
    used?: number;
    limit?: number | null;
    unit: string;
  }>;
};

export type ProviderUsageResponse = {
  providerId: string;
  runtimeId: string;
  usage: ProviderUsageReport;
};
