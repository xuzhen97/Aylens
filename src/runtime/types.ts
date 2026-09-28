import type { RuntimeSelectorConfig } from "../config/schema.js";
import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";

/**
 * Identifier of the Gateway's own runtime record.
 *
 * It is control-plane bookkeeping, not a schedulable node: it never heartbeats,
 * advertises no provider types, and `runtime.mode = "local"` reaches LocalRuntime
 * directly without consulting the registry at all. Treat it as Gateway status
 * only — never as a placement target.
 */
export const LOCAL_RUNTIME_ID = "local";

export type RuntimeStatus = "online" | "degraded" | "draining" | "offline";

export interface RuntimeCapabilities {
  providerTypes: string[];
  browsers: string[];
  profiles: string[];
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

export type RuntimeTarget =
  | { mode: "local" }
  | { nodeId: string }
  | { selector: RuntimeSelectorConfig };

export interface RuntimeExecutionRequest {
  jobId: string;
  executionId: string;
  providerId: string;
  providerType: string;
  providerConfig: import("../config/schema.js").ProviderConfig;
  operation: "search";
  input: SearchRequest;
  requestId: string;
  traceId: string;
  /** Present for in-process execution, where there is no CANCEL message to send. */
  signal?: AbortSignal | undefined;
}

export interface RuntimeExecutionResult {
  runtimeId: string;
  output: ProviderSearchResponse;
}

export interface ExecutionRuntime {
  readonly id: string;
  execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult>;
}
