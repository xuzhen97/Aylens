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

export interface RunnerRuntime {
  providers: ProviderRegistry;
  deployments: RunnerConfig["providers"];
  transports: TransportRegistry;
  profiles: BrowserProfileManager;
  browser: BrowserHost;
  pluginTypes: string[];
  close(): Promise<void>;
}

export async function createRunnerRuntime(config: RunnerConfig): Promise<RunnerRuntime> {
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

  return {
    providers,
    deployments: config.providers,
    transports,
    profiles,
    browser,
    pluginTypes: providers.factoryTypes(),
    close: async () => browser.close(),
  };
}
