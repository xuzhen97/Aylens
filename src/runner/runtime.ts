import { BrowserProfileManager } from "../browser/profile-manager.js";
import { ChromeProfileHost } from "../browser/chrome-profile-host.js";
import type { BrowserHost } from "../browser/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { loadProviderPlugins } from "../providers/plugin.js";
import { DirectTransportFactory } from "../transports/direct.js";
import { HttpProxyTransportFactory } from "../transports/http-proxy.js";
import { Socks5TransportFactory } from "../transports/socks5.js";
import { TransportRegistry } from "../transports/registry.js";
import type { RunnerConfig } from "./config.js";
import type { ProxyConfigService } from "./proxy-config-service.js";
import { buildExecutionSnapshot, type ExecutionSnapshot } from "./execution-snapshot.js";
import type { ProviderAuthState } from "../providers/types.js";

export interface RunnerRuntime {
  providers: ProviderRegistry;
  deployments: RunnerConfig["providers"];
  transports: TransportRegistry;
  profiles: BrowserProfileManager;
  browser: BrowserHost;
  pluginTypes: string[];
  providerAuthStates: Map<string, ProviderAuthState>;
  /** 代理配置服务;未接入数据库的旧调用方可省略。 */
  proxyConfig: ProxyConfigService | undefined;
  /** 任务开始时取得不可变快照;新任务总是读到当前已发布版本。 */
  captureExecution(): ExecutionSnapshot;
  reportProviderAuthState(providerId: string, state: ProviderAuthState): void;
  close(): Promise<void>;
}

export async function createRunnerRuntime(
  config: RunnerConfig,
  options: { proxyConfig?: ProxyConfigService } = {},
): Promise<RunnerRuntime> {
  const transports = new TransportRegistry();
  transports.registerFactory(new DirectTransportFactory());
  transports.registerFactory(new HttpProxyTransportFactory());
  transports.registerFactory(new Socks5TransportFactory());

  for (const [id, transport] of Object.entries(config.transports)) {
    transports.build(id, transport);
  }

  const profiles = new BrowserProfileManager();
  for (const [id, profile] of Object.entries(config.browserProfiles)) {
    profiles.register({ id, ...profile });
  }

  const browser = new ChromeProfileHost(profiles, transports);
  const loaded = await loadProviderPlugins(config.plugins.modules, config.plugins.baseDir);

  const providers = new ProviderRegistry();
  for (const factory of loaded.factories) providers.registerFactory(factory);
  const providerAuthStates = new Map<string, ProviderAuthState>();

  // 活动快照:代理配置切换时整体替换;任务只读它 capture 到的版本。
  let activeSnapshot: ExecutionSnapshot;
  if (options.proxyConfig) {
    activeSnapshot = buildExecutionSnapshot(options.proxyConfig.readState(), config, browser);
  } else {
    activeSnapshot = {
      version: 0,
      deployments: config.providers,
      transports,
      browser,
    };
  }

  const reportProviderAuthState = (providerId: string, state: ProviderAuthState) => {
    const previous = providerAuthStates.get(providerId);
    providerAuthStates.set(providerId, {
      ...state,
      ...(state.account
        ? { account: state.account }
        : previous?.account
          ? { account: previous.account }
          : {}),
    });
  };

  return {
    providers,
    get deployments() {
      return activeSnapshot.deployments;
    },
    get transports() {
      return activeSnapshot.transports;
    },
    profiles,
    get browser() {
      return activeSnapshot.browser;
    },
    pluginTypes: providers.factoryTypes(),
    providerAuthStates,
    proxyConfig: options.proxyConfig,
    captureExecution: () => activeSnapshot,
    reportProviderAuthState,
    close: async () => browser.close(),
  };
}
