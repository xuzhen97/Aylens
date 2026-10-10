import type { ProviderConfig, ProviderDeploymentConfig } from "../config/schema.js";
import type { ProviderExtractResponse, ExtractRequest } from "../contracts/extract.js";
import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";
import type { BrowserHost } from "../browser/types.js";
import type { TransportRegistry } from "../transports/registry.js";
import type { CredentialPool } from "../runner/credentials/pool.js";

/**
 * API 型 Provider 获取凭据的方式。
 *
 * 声明为独立接口而不是直接依赖 CredentialConfigService，
 * 是为了让浏览器型 Provider 完全不感知凭据池的存在；
 * 该注入是**可选的**：没有它的 Runner 无法执行 API Provider，
 * 由工厂在 create() 时显式抛错，而不是静默降级成无认证调用。
 */
export interface ProviderCredentialAccess {
  /**
   * 取该 Provider 绑定的凭据池。
   *
   * 同时返回 poolId：Provider 需要它作为 acquire 的分组键，
   * 也让“未绑定”的情况在调用点显式抛错，而不是拿到一个空池后静默失败。
   */
  poolForProvider(providerId: string): { poolId: string; pool: CredentialPool };
}

export interface ProviderContext {
  requestId: string;
  traceId: string;
  runtimeId: string;
  jobId?: string | undefined;
  /**
   * 当 Gateway 放弃任务或 Runner 正在关闭时触发取消；能响应取消信号的 Provider 应尽快停止工作。
   */
  signal?: AbortSignal | undefined;
}

/**
 * Provider 支持的全部执行能力（单一真相源）。
 *
 * 运行时常量与类型都从这里派生，避免校验器和类型各自维护一份白名单 ——
 * 那正是“新增能力却在别处被硬编码旧白名单拒掉”的事故形状。
 * 按 ADR-2026-10-09-retrieval-capability-contracts：Search/Extract 独立声明，
 * usage 是可选管理能力，同样显式声明。
 */
export const PROVIDER_CAPABILITIES = ["search", "extract", "usage"] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/**
 * 用量/额度报告。accuracy 区分数据来源,避免把估算当账单、把不可用当 0。
 */
export interface ProviderUsageEntry {
  scope: "credential" | "account";
  used?: number | undefined;
  limit?: number | null | undefined;
  /** 单位,如 credits / requests / USD,不跨服务商比较。 */
  unit: string;
}

export interface ProviderUsageReport {
  service: string;
  fetchedAt: number;
  accuracy: "official" | "response" | "estimated" | "unknown";
  supported: boolean;
  entries: ProviderUsageEntry[];
}

export type ProviderAuthStatus = "unknown" | "authenticated" | "auth_required";

export interface ProviderAuthAccount {
  handle: string;
  displayName?: string | undefined;
}

export interface ProviderAuthState {
  status: ProviderAuthStatus;
  account?: ProviderAuthAccount | undefined;
  checkedAt: number;
}

export interface SearchProvider {
  readonly id: string;
  search(context: ProviderContext, request: SearchRequest): Promise<ProviderSearchResponse>;
  /** 仅当工厂 capabilities 声明 "extract" 时实现;Gateway 会按声明派发。 */
  extract?(context: ProviderContext, request: ExtractRequest): Promise<ProviderExtractResponse>;
  /** 可选管理能力;不支持时可调用方显示“不支持”,不发送付费请求。 */
  usage?(context: ProviderContext): Promise<ProviderUsageReport>;
  checkAuth?(context: ProviderContext): Promise<ProviderAuthState>;
  openLogin?(context: ProviderContext): Promise<ProviderAuthState>;
}

export interface ProviderFactoryContext {
  transports: TransportRegistry;
  browser?: BrowserHost | undefined;
  /** Runner 级默认浏览器 Profile；Provider 未显式指定时可复用同一持久化工作区。 */
  defaultBrowserProfile?: string | undefined;
  /** Provider 可上报不含凭据的最近认证状态，供 Runner heartbeat / Admin UI 展示。 */
  reportAuthState?: ((state: ProviderAuthState) => void) | undefined;
  /** API 凭据池访问；凭据池型 Provider 必填，浏览器型 Provider 不使用。 */
  credentials?: ProviderCredentialAccess | undefined;
}

export interface ProviderFactory {
  readonly type: string;
  /**
   * 必填:该 Provider type 实际实现的操作。
   * 设为必填而非可选缺省,是为了让“声明了 extract 却没实现”成为编译期错误,
   * 而不是运行时静默降级(该仓库历史上可选注入导致过多静默失败)。
   */
  readonly capabilities: readonly ProviderCapability[];
  /** 声明该 Provider type 是否支持通用的人工登录状态控制。 */
  readonly authControl?: boolean | undefined;
  create(
    id: string,
    config: ProviderDeploymentConfig,
    context: ProviderFactoryContext,
  ): SearchProvider;
}

export interface ProviderDefinition {
  id: string;
  config: ProviderConfig;
}
