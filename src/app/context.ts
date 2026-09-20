import { platform, hostname } from "node:os";
import type { AppConfig } from "../config/schema.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { ProviderFactory } from "../providers/types.js";
import { TransportRegistry } from "../transports/registry.js";
import { DirectTransportFactory } from "../transports/direct.js";
import { HttpProxyTransportFactory } from "../transports/http-proxy.js";
import { Socks5TransportFactory } from "../transports/socks5.js";
import type { TransportFactory } from "../transports/types.js";
import { RuntimeRegistry } from "../runtime/registry.js";
import { LocalRuntime } from "../runtime/local-runtime.js";
import { RunnerSessionManager } from "../runtime/runner-session-manager.js";
import { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { InMemoryAuditService } from "../audit/audit-service.js";
import { ProviderRouter } from "../search/router.js";
import { SearchService } from "../search/search-service.js";
import { BrowserProfileManager } from "../browser/profile-manager.js";
import { ChromeProfileHost } from "../browser/chrome-profile-host.js";

function normalizeOs(value: NodeJS.Platform): "windows" | "linux" | "darwin" {
  if (value === "win32") return "windows";
  if (value === "darwin") return "darwin";
  return "linux";
}

export interface GatewayContext {
  config: AppConfig;
  providers: ProviderRegistry;
  transports: TransportRegistry;
  runtimes: RuntimeRegistry;
  runnerSessions: RunnerSessionManager;
  browserProfiles: BrowserProfileManager;
  browser: ChromeProfileHost;
  audit: InMemoryAuditService;
  search: SearchService;
}

export interface GatewayExtensions {
  providerFactories?: ProviderFactory[];
  transportFactories?: TransportFactory[];
}

export function createGatewayContext(
  config: AppConfig,
  extensions: GatewayExtensions = {},
): GatewayContext {
  const providers = new ProviderRegistry();
  for (const factory of extensions.providerFactories ?? []) providers.registerFactory(factory);
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    providers.addDefinition(id, providerConfig);
  }

  const transports = new TransportRegistry();
  transports.registerFactory(new DirectTransportFactory());
  transports.registerFactory(new HttpProxyTransportFactory());
  transports.registerFactory(new Socks5TransportFactory());
  for (const factory of extensions.transportFactories ?? []) transports.registerFactory(factory);
  for (const [id, transportConfig] of Object.entries(config.transports)) {
    transports.build(id, transportConfig);
  }

  const runtimes = new RuntimeRegistry(config.runtimeRegistry.offlineAfterMs);
  runtimes.upsert({
    id: "local",
    hostname: hostname(),
    os: normalizeOs(platform()),
    version: "0.1.0",
    protocolVersion: "local",
    status: "online",
    labels: { role: "gateway" },
    capabilities: {
      providerTypes: providers.factoryTypes(),
      browsers: [],
      profiles: Object.keys(config.browserProfiles),
      http: true,
      browserAutomation: false,
    },
    capacity: { maxJobs: 64, activeJobs: 0 },
    lastSeenAt: Date.now(),
  });

  const runnerSessions = new RunnerSessionManager(config.runtimeRegistry.jobTimeoutMs);
  const browserProfiles = new BrowserProfileManager();
  for (const [id, profile] of Object.entries(config.browserProfiles)) {
    browserProfiles.register({ id, ...profile });
  }

  const browser = new ChromeProfileHost(browserProfiles, transports);
  const localRuntime = new LocalRuntime(providers, { transports, browser });
  const dispatcher = new ExecutionDispatcher(providers, runtimes, localRuntime, runnerSessions);
  const audit = new InMemoryAuditService();
  const router = new ProviderRouter(config);
  const search = new SearchService(router, dispatcher, audit);

  return {
    config,
    providers,
    transports,
    runtimes,
    runnerSessions,
    browserProfiles,
    browser,
    audit,
    search,
  };
}
