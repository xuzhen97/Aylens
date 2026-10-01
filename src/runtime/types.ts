import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";
import type { ProviderAuthState } from "../providers/types.js";

export type RuntimeStatus = "online" | "degraded" | "draining" | "offline";

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
  browsers: string[];
  profiles: string[];
  profileDetails?: RuntimeBrowserProfileState[];
  providerStates?: Record<string, ProviderAuthState>;
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
  operation: "search" | "auth_check" | "auth_login";
  input: SearchRequest | Record<string, never>;
  requestId: string;
  traceId: string;
}

export interface RuntimeExecutionResult<T = ProviderSearchResponse> {
  runtimeId: string;
  output: T;
}
