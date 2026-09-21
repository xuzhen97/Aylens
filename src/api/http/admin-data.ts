import type { GatewayContext } from "../../app/context.js";
import type { AuditRecord } from "../../audit/audit-service.js";
import type { BrowserProfileDefinition } from "../../browser/profile-manager.js";

const SENSITIVE_QUERY_KEY = /^(?:access_?token|api_?key|auth|authorization|code|credential|key|password|secret|session|signature|token)$/i;
const SENSITIVE_LABEL_KEY = /(?:token|secret|password|passwd|api.?key|credential|authorization|auth)/i;

function redactLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      SENSITIVE_LABEL_KEY.test(key) ? "***" : value,
    ]),
  );
}

function toSafeRuntimeTarget(
  runtime: ReturnType<GatewayContext["providers"]["getDefinition"]>["config"]["runtime"],
) {
  if ("selector" in runtime && runtime.selector.labels) {
    return {
      selector: {
        ...runtime.selector,
        labels: redactLabels(runtime.selector.labels),
      },
    };
  }

  return runtime;
}

function redactQuery(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;

    url.username = "";
    url.password = "";

    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, "***");
      }
    }

    return url.toString();
  } catch {
    return trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
  }
}

export function toSafeBrowserProfile(
  profile: BrowserProfileDefinition & { activeLeases: number },
) {
  return {
    id: profile.id,
    scope: "gateway-local" as const,
    runtimeId: "local",
    browser: profile.browser,
    mode: profile.mode,
    persistent: profile.persistent,
    maxConcurrency: profile.maxConcurrency,
    activeLeases: profile.activeLeases,
    interactive: profile.interactive,
    headless: profile.headless,
    channel: profile.channel,
    transport: profile.transport,
  };
}

function toSafeAudit(record: AuditRecord) {
  return {
    requestId: record.requestId,
    traceId: record.traceId,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    status: record.status,
    request: {
      query: redactQuery(record.request.query),
      route: record.request.route,
      sources: record.request.sources,
      limit: record.request.limit,
      language: record.request.language,
    },
    providers: record.providers.map((event) => ({ ...event })),
  };
}

export function buildAdminOverview(context: GatewayContext) {
  const runtimes = context.runtimes.list();
  const localProfiles = context.browserProfiles.list().map(toSafeBrowserProfile);
  const remoteProfiles = runtimes
    .filter((runtime) => runtime.id !== "local")
    .flatMap((runtime) => runtime.capabilities.profiles.map((profileId) => ({
      id: profileId,
      scope: "runner" as const,
      runtimeId: runtime.id,
      browser: runtime.capabilities.browsers.length === 1
        ? runtime.capabilities.browsers[0]
        : undefined,
      mode: undefined,
      persistent: undefined,
      maxConcurrency: undefined,
      activeLeases: undefined,
      interactive: undefined,
      headless: undefined,
      channel: undefined,
      transport: undefined,
    })));

  const providers = context.providers.list().map(({ id, config }) => ({
    id,
    type: config.type,
    enabled: config.enabled,
    runtime: toSafeRuntimeTarget(config.runtime),
    browserProfile: config.browser?.profile,
    transport: config.transport?.primary,
  }));

  const audits = context.audit.list(30).map(toSafeAudit);
  const onlineRuntimes = runtimes.filter((runtime) =>
    runtime.status === "online" || runtime.status === "degraded"
  );

  return {
    generatedAt: Date.now(),
    gateway: {
      status: "ready" as const,
      localRuntime: runtimes.find((runtime) => runtime.id === "local")?.status ?? "offline",
      remoteRuntimes: runtimes.filter((runtime) => runtime.id !== "local").length,
    },
    summary: {
      providers: providers.length,
      enabledProviders: providers.filter((provider) => provider.enabled).length,
      runtimes: runtimes.length,
      onlineRuntimes: onlineRuntimes.length,
      remoteRuntimes: runtimes.filter((runtime) => runtime.id !== "local").length,
      browserProfiles: localProfiles.length + remoteProfiles.length,
      recentAudits: audits.length,
    },
    providers,
    runtimes: runtimes.map((runtime) => ({
      ...runtime,
      labels: redactLabels(runtime.labels),
    })),
    browserProfiles: [...localProfiles, ...remoteProfiles],
    audits,
  };
}
