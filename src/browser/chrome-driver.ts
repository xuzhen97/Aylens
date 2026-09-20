import { chromium, type BrowserContext } from "playwright-core";
import type { BrowserProfileDefinition } from "./profile-manager.js";
import type { TransportConfig } from "../config/schema.js";

type PersistentContextOptions =
  NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export interface BrowserDriverResult {
  context: BrowserContext;
  close: () => Promise<void>;
}

export interface BrowserDriver {
  open(
    profile: BrowserProfileDefinition,
    transport?: TransportConfig,
  ): Promise<BrowserDriverResult>;
}

export function toPlaywrightProxySettings(
  config: TransportConfig | undefined,
): PersistentContextOptions["proxy"] {
  if (!config || config.type === "direct") return undefined;

  const proxy = new URL(config.url);
  const server = `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}`;

  const settings: NonNullable<PersistentContextOptions["proxy"]> = { server };
  if (proxy.username) settings.username = decodeURIComponent(proxy.username);
  if (proxy.password) settings.password = decodeURIComponent(proxy.password);
  return settings;
}

export class PlaywrightChromeDriver implements BrowserDriver {
  async open(
    profile: BrowserProfileDefinition,
    transport?: TransportConfig,
  ): Promise<BrowserDriverResult> {
    if (profile.mode === "cdp") {
      if (!profile.cdpEndpoint) {
        throw new Error(`Browser profile requires cdpEndpoint: ${profile.id}`);
      }

      const browser = await chromium.connectOverCDP(profile.cdpEndpoint);
      const context = browser.contexts()[0];

      if (!context) {
        throw new Error(`CDP browser has no default context: ${profile.id}`);
      }

      return {
        context,
        // The external CDP browser is not owned by Aylens. Do not terminate it here.
        close: async () => undefined,
      };
    }

    const options: PersistentContextOptions = {
      headless: profile.headless,
      args: profile.args,
    };

    const proxy = toPlaywrightProxySettings(transport);
    if (proxy) options.proxy = proxy;

    if (profile.executablePath) {
      options.executablePath = profile.executablePath;
    } else if (profile.channel) {
      options.channel = profile.channel;
    }

    const context = await chromium.launchPersistentContext(profile.userDataDir, options);

    return {
      context,
      close: async () => context.close(),
    };
  }
}
