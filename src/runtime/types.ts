import type { ProviderExtractResponse, ExtractRequest } from "../contracts/extract.js";
import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";
import type { ProviderAuthState, ProviderCapability } from "../providers/types.js";

export type RuntimeStatus = "online" | "degraded" | "draining" | "offline";

/** Gateway 与 Runner 之间的执行操作枚举。 */
export type RuntimeExecutionOperation = "search" | "extract" | "usage" | "auth_check" | "auth_login";

export interface RuntimeBrowserProfileState {
  id: string;
  browser: string;
  mode: "launch" | "cdp";
  activeLeases: number;
  maxConcurrency: number;
  interactive: boolean;
  transport: string;
}

export interface RuntimeCapabilities {
  providerTypes: string[];
  providerIds: string[];
  authProviderIds?: string[];
  /**
   * Provider ID → 该 Runner 上实际装配的操作能力。
   * 旧 Runner 缺省该字段：Gateway 对 search/auth 照旧派发（旧行为不变），
   * 但对新能力 extract 明确拒绝，而不是乐观派发。
   */
  providerOperations?: Record<string, ProviderCapability[]> | undefined;
  browsers: string[];
  profiles: string[];
  profileDetails?: RuntimeBrowserProfileState[];
  providerStates?: Record<string, ProviderAuthState>;
  /** 新 Runner 才支持代理配置通道;旧 Runner 缺省 false。 */
  proxyConfig?: boolean;
  /** API 凭据池的管理能力。与 proxyConfig 独立:只支持其中一个时另一个必须明确拒绝。 */
  credentialConfig?: boolean | undefined;
  http: boolean;
  browserAutomation: boolean;
}

export interface RuntimeCapacity {
  maxJobs: number;
  activeJobs: number;
}

export interface RuntimeRecord {
  id: string;
  hostname: string;
  os: "windows" | "linux" | "darwin";
  version: string;
  protocolVersion: string;
  status: RuntimeStatus;
  labels: Record<string, string>;
  capabilities: RuntimeCapabilities;
  capacity: RuntimeCapacity;
  lastSeenAt: number;
}

export interface RuntimeExecutionRequest {
  jobId: string;
  executionId: string;
  providerId: string;
  providerType: string;
  operation: RuntimeExecutionOperation;
  input: SearchRequest | ExtractRequest | Record<string, never>;
  requestId: string;
  traceId: string;
}

export interface RuntimeExecutionResult<T = ProviderSearchResponse> {
  runtimeId: string;
  output: T;
}

export interface RuntimeExtractResult {
  runtimeId: string;
  output: ProviderExtractResponse;
}
