import type { ProviderSearchResponse, SearchRequest } from "../contracts/search.js";

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
  browsers: string[];
  profiles: string[];
  profileDetails?: RuntimeBrowserProfileState[];
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
  operation: "search";
  input: SearchRequest;
  requestId: string;
  traceId: string;
}

export interface RuntimeExecutionResult {
  runtimeId: string;
  output: ProviderSearchResponse;
}
