/**
 * API 凭据域模型。
 *
 * 这是 Runner 本地的**凭据池**，与 Browser Profile / Lease 完全无关：
 * Tavily / Exa / AnySearch 通过 HTTP Transport 直接调用 API，
 * 不启动 Chrome、不占用浏览器租约、不使用 Cookie。
 * 见 docs/adr/2026-10-09-api-credential-pool-scheduling.md。
 */

/**
 * 凭据可用状态。管理启停(enabled)与运行健康(availability)是两条独立轴：
 * 人工禁用不等于坏掉，冷却结束不等于被永久拉黑。
 */
export type CredentialAvailability =
  | "available"
  | "cooling"
  | "auth_failed"
  | "quota_blocked"
  | "disabled"
  | "unknown";

/**
 * 上游失败类别。由服务商适配器解释，公共层不做字符串猜测。
 */
export type CredentialFailureCategory =
  | "invalid_request"
  | "auth"
  | "permission"
  | "rate_limited"
  | "quota"
  | "network"
  | "upstream"
  | "item_content";

/**
 * 失败影响范围 —— 分层限流的核心。
 *
 * 决定“能不能换下一个 Key”：account / endpoint_group 范围的失败
 * 说明换同一组的 Key 也没用，继续轮换只会雪上加霜。
 * unknown 是刻意保留的：范围不明时保守处理，不猜。
 */
export type CredentialFailureScope =
  | "request"
  | "credential"
  | "account"
  | "endpoint_group"
  | "service"
  | "unknown";

export interface CredentialFailure {
  category: CredentialFailureCategory;
  scope: CredentialFailureScope;
  /** 合法 Retry-After 换算后的毫秒；上游没给就为 undefined。 */
  retryAfterMs?: number | undefined;
  /** scope 为 endpoint_group 时指明是哪一组接口；其他 scope 忽略。 */
  endpointGroup?: string | undefined;
}

/** 一个凭据池：同一服务商的一组可轮询 Key。池与服务商一一绑定，不跨服务混合。 */
export interface CredentialPoolRecord {
  id: string;
  service: string;
  name: string;
  enabled: boolean;
}

export interface CredentialRecord {
  id: string;
  poolId: string;
  name: string;
  /** 明文只存在 Runner 数据库与内存快照中，绝不出现在任何读取接口或日志里。 */
  secret: string;
  enabled: boolean;
  /** 账号/Team 分组，用于识别“同一账号的多个 Key”。不声称自动验证归属。 */
  accountGroup?: string | undefined;
  createdAt: number;
}

/** 跨重启必须保留的运行状态。瞬时并发占用不持久化。 */
export interface CredentialStateEntry {
  availability: CredentialAvailability;
  cooldownUntil?: number | undefined;
  lastFailureCategory?: CredentialFailureCategory | undefined;
  lastSuccessAt?: number | undefined;
}

/** 活动快照：一次原子替换的整体，读取方始终拿到不可变对象。 */
export interface CredentialRuntimeState {
  version: number;
  /** 最近一次成功写入的操作 ID，用于断线后核对“结果待确认”。 */
  lastOperationId?: string | undefined;
  pools: CredentialPoolRecord[];
  credentials: CredentialRecord[];
  /** Provider ID → pool ID；null 表示显式无绑定。 */
  bindings: Record<string, string | null>;
  state: Record<string, CredentialStateEntry>;
}

/** 脱敏视图：唯一允许发往 Gateway / Admin 的形态，序列化后不含任何明文秘密。 */
export interface SafeCredentialConfig {
  version: number;
  lastOperationId?: string | undefined;
  pools: Array<{
    id: string;
    service: string;
    name: string;
    enabled: boolean;
    credentialCount: number;
    providerRefs: string[];
  }>;
  credentials: Array<{
    id: string;
    poolId: string;
    name: string;
    enabled: boolean;
    accountGroup?: string | undefined;
    maskedSecret: string;
    availability: CredentialAvailability;
    cooldownUntil?: number | undefined;
    lastFailureCategory?: CredentialFailureCategory | undefined;
    lastSuccessAt?: number | undefined;
  }>;
  providers: Array<{ id: string; poolId: string | null; service?: string | undefined }>;
}
