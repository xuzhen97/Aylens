import type { GatewayContext } from "../../app/context.js";
import type { AuditRecord } from "../../audit/audit-service.js";

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

  // Profile 由已连接的 Runner 上报；Gateway 自身不持有 Profile，也不会启动或操作浏览器。
  const browserProfiles = runtimes.flatMap((runtime) =>
    runtime.capabilities.profiles.map((profileId) => ({
      id: profileId,
      scope: "runner" as const,
      runtimeId: runtime.id,
      browser: runtime.capabilities.browsers.length === 1
        ? runtime.capabilities.browsers[0]
        : undefined,
    })));

  const providers = context.providers.list().map(({ id, config }) => ({
    id,
    type: config.type,
    enabled: config.enabled,
    runtime: toSafeRuntimeTarget(config.runtime),
  }));

  const audits = context.audit.list(30).map(toSafeAudit);
  const onlineNodes = runtimes.filter((runtime) =>
    runtime.status === "online" || runtime.status === "degraded"
  );

  return {
    generatedAt: Date.now(),
    gateway: {
      status: "ready" as const,
    },
    summary: {
      providers: providers.length,
      enabledProviders: providers.filter((provider) => provider.enabled).length,
      runtimes: runtimes.length,
      onlineRuntimes: onlineNodes.length,
      browserProfiles: browserProfiles.length,
      recentAudits: audits.length,
    },
    providers,
    runtimes: runtimes.map((runtime) => ({
      ...runtime,
      labels: redactLabels(runtime.labels),
    })),
    browserProfiles,
    audits,
  };
}
