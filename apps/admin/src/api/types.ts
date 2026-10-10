export type ApiError = Error & {
  status: number;
  code: string;
  retryAfterSeconds?: number;
};

export type SessionInfo = {
  authenticated: true;
  expiresAt: number;
  csrfToken: string;
};

export type SearchRequest = {
  query: string;
  route?: string;
  sources?: string[];
  limit?: number;
  language?: string;
};

export type SearchResponse = {
  requestId: string;
  traceId: string;
  status: "completed" | "partial" | "failed";
  items: Array<{
    id: string;
    platform: string;
    type: string;
    url: string;
    canonicalUrl?: string;
    title?: string;
    text?: string;
    snippet?: string;
    publishedAt?: string;
    retrievedAt: string;
    score?: number;
    provenance: {
      provider: string;
      retrievalMethod: string;
      providerItemId?: string;
      requestId: string;
      fetchedAt: string;
      runtimeId?: string;
    };
    extensions?: Record<string, unknown>;
  }>;
  meta: {
    providers: Record<string, {
      status: "success" | "failed";
      runtimeId?: string;
      latencyMs: number;
      resultCount: number;
      error?: { code: string; message: string; retryable: boolean };
    }>;
  };
};

export type AdminOverview = {
  generatedAt: number;
  gateway: { status: "ready" };
  summary: {
    providers: number;
    enabledProviders: number;
    runtimes: number;
    onlineRuntimes: number;
    browserProfiles: number;
    recentAudits: number;
  };
  providers: Array<{
    id: string;
    type: string;
    enabled: boolean;
    runtime?: Record<string, unknown>;
    authControl: boolean;
    authRuntimeId?: string;
    auth?: {
      status: "authenticated" | "auth_required" | "unknown";
      checkedAt?: number;
      account?: { displayName?: string; handle?: string };
    };
  }>;
  runtimes: Array<{
    id: string;
    hostname: string;
    os: "windows" | "linux" | "darwin";
    version: string;
    protocolVersion: string;
    status: "online" | "degraded" | "draining" | "offline";
    labels: Record<string, string>;
    capabilities: {
      providerTypes: string[];
      providerIds: string[];
      authProviderIds?: string[];
      browsers: string[];
      profiles: string[];
      profileDetails?: Array<{
        id: string;
        browser: string;
        mode: "launch" | "cdp";
        activeLeases: number;
        maxConcurrency: number;
        interactive: boolean;
        transport: string;
      }>;
      providerStates?: Record<string, AdminOverview["providers"][number]["auth"]>;
      proxyConfig?: boolean;
      /** API 凭据池管理能力；旧 Runner 缺省 false，界面只读。 */
      credentialConfig?: boolean;
      http: boolean;
      browserAutomation: boolean;
    };
    capacity: { maxJobs: number; activeJobs: number };
    lastSeenAt: number;
  }>;
  browserProfiles: Array<{
    id: string;
    scope: "runner";
    runtimeId: string;
    status: "available" | "busy" | "draining" | "offline" | "unknown";
    browser?: string;
    mode?: "launch" | "cdp";
    activeLeases?: number;
    maxConcurrency?: number;
    interactive?: boolean;
    transport?: string;
  }>;
  audits: Array<{
    requestId: string;
    traceId: string;
    createdAt: number;
    completedAt?: number;
    status: "completed" | "partial" | "failed" | "running";
    request: { query: string; route?: string; sources?: string[]; limit?: number; language?: string };
    providers: Array<{
      providerId: string;
      runtimeId?: string;
      status: "success" | "failed";
      resultCount?: number;
      error?: { code: string; message: string; retryable: boolean };
    }>;
  }>;
};

export type ProviderAuthResponse = {
  providerId: string;
  runtimeId: string;
  auth: NonNullable<AdminOverview["providers"][number]["auth"]>;
};
