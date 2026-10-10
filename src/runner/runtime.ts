import { BrowserProfileManager } from "../browser/profile-manager.js";
import { ChromeProfileHost } from "../browser/chrome-profile-host.js";
import type { BrowserHost } from "../browser/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { loadProviderPlugins } from "../providers/plugin.js";
import { DirectTransportFactory } from "../transports/direct.js";
import { HttpProxyTransportFactory } from "../transports/http-proxy.js";
import { Socks5TransportFactory } from "../transports/socks5.js";
import { TransportRegistry } from "../transports/registry.js";
import { RetrievalError } from "../core/errors.js";
import type { RunnerConfig } from "./config.js";
import type { ProxyConfigService } from "./proxy-config-service.js";
import type { CredentialConfigService } from "./credentials/service.js";
import { CredentialPool } from "./credentials/pool.js";
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
  /** API 凭据配置服务。与 proxyConfig 独立：两者都由 Runner 启动时接入。 */
  credentials: CredentialConfigService | undefined;
  /**
   * 取该 Provider 绑定的凭据池，供 API 型 Provider 取 Key。
   *
   * 内部按配置版本惰性刷新：配置写入后新请求看到新 Key，
   * 未变更时不重复重建（进行中的占用得以保留）。
   */
  credentialPool(providerId: string): { poolId: string; pool: CredentialPool };
  /** 任务开始时取得不可变快照;新任务总是读到当前已发布版本。 */
  captureExecution(): ExecutionSnapshot;
  reportProviderAuthState(providerId: string, state: ProviderAuthState): void;
  close(): Promise<void>;
}

export async function createRunnerRuntime(
  config: RunnerConfig,
  // 必填：两个服务都是真实入口应当装配的能力。缺任一由调用点显式传 undefined，
  // 不默认成 `{}`，避免新增入口漏传后能力静默降级（该仓库已知的事故模式）。
  options: {
    proxyConfig: ProxyConfigService | undefined;
    credentials: CredentialConfigService | undefined;
  },
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

  // 凭据池：所有池共享一个实例（内部按 poolId 分组），按配置版本惰性刷新。
  const initialCredentialState = options.credentials?.snapshot() ?? {
    version: 0,
    pools: [],
    credentials: [],
    bindings: {},
    state: {},
  };
  const credentialPool = new CredentialPool(initialCredentialState);
  let credentialPoolVersion = initialCredentialState.version;

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
    credentials: options.credentials,
    credentialPool: (providerId: string) => {
      if (!options.credentials) {
        throw new RetrievalError(
          "PROVIDER_UNAVAILABLE",
          `Runner has no credential service for provider: ${providerId}`,
          { retryable: false },
        );
      }
      // 按配置版本惰性刷新：写入后新请求看到新 Key；未变更时不重建，
      // 进行中的并发占用得以保留（replaceState 按内容指纹保留）。
      const state = options.credentials.snapshot();
      if (state.version !== credentialPoolVersion) {
        credentialPool.replaceState(state);
        credentialPoolVersion = state.version;
      }
      const poolId = state.bindings[providerId];
      if (poolId === undefined || poolId === null) {
        throw new RetrievalError(
          "PROVIDER_UNAVAILABLE",
          `Provider has no credential pool bound: ${providerId}`,
          { retryable: false },
        );
      }
      return { poolId, pool: credentialPool };
    },
    captureExecution: () => activeSnapshot,
    reportProviderAuthState,
    close: async () => browser.close(),
  };
}
