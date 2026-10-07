import type { AdminOverview } from "../api/types";

export const emptyOverview: AdminOverview = {
  generatedAt: 1_700_000_000_000,
  gateway: { status: "ready" },
  summary: { providers: 0, enabledProviders: 0, runtimes: 0, onlineRuntimes: 0, browserProfiles: 0, recentAudits: 0 },
  providers: [],
  runtimes: [],
  browserProfiles: [],
  audits: [],
};

export const overviewWithOldRunner: AdminOverview = {
  ...emptyOverview,
  summary: { providers: 1, enabledProviders: 1, runtimes: 1, onlineRuntimes: 1, browserProfiles: 1, recentAudits: 0 },
  providers: [{ id: "browserRead", type: "generic-browser", enabled: true, authControl: true, auth: { status: "auth_required" } }],
  runtimes: [{
    id: "runner-1", hostname: "host-1", os: "linux", version: "1.0", protocolVersion: "1", status: "online",
    labels: {}, capabilities: {
      providerTypes: ["generic-browser"], providerIds: ["browserRead"], browsers: ["chrome"], profiles: ["main"],
      http: true, browserAutomation: true,
    }, capacity: { maxJobs: 4, activeJobs: 1 }, lastSeenAt: 1_700_000_000_000,
  }],
  browserProfiles: [{ id: "main", scope: "runner", runtimeId: "runner-1", status: "unknown" }],
};

export const partialSearch = {
  requestId: "request-1", traceId: "trace-1", status: "partial" as const, items: [],
  meta: { providers: { browserRead: {
    status: "failed" as const, runtimeId: "runner-1", latencyMs: 35, resultCount: 0,
    error: { code: "UPSTREAM_ERROR", message: "provider unavailable", retryable: true },
  } } },
};
