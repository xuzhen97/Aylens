import type { BrowserContext } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { BrowserProfileManager } from "../src/browser/profile-manager.js";
import { ChromeProfileHost } from "../src/browser/chrome-profile-host.js";
import {
  toPlaywrightProxySettings,
  type BrowserDriver,
} from "../src/browser/chrome-driver.js";
import { TransportRegistry } from "../src/transports/registry.js";
import { HttpProxyTransportFactory } from "../src/transports/http-proxy.js";

describe("Playwright proxy mapping", () => {
  it("separates proxy credentials from the server address", () => {
    expect(toPlaywrightProxySettings({
      type: "http-proxy",
      url: "http://user%40example.com:p%40ss@proxy.local:8080",
    })).toEqual({
      server: "http://proxy.local:8080",
      username: "user@example.com",
      password: "p@ss",
    });
  });
});

describe("ChromeProfileHost", () => {
  it("opens a persistent profile lazily, reuses it, and passes its local transport config", async () => {
    const profiles = new BrowserProfileManager();
    profiles.register({
      id: "xhs-main",
      browser: "chrome",
      mode: "launch",
      persistent: true,
      userDataDir: "D:/profiles/xhs-main",
      maxConcurrency: 1,
      interactive: true,
      headless: true,
      channel: "chrome",
      args: [],
      transport: "proxy-local",
    });

    const transports = new TransportRegistry();
    transports.registerFactory(new HttpProxyTransportFactory());
    transports.build("proxy-local", {
      type: "http-proxy",
      url: "http://user:pass@127.0.0.1:8888",
    });

    const context = {} as BrowserContext;
    const close = vi.fn(async () => undefined);
    const open = vi.fn<BrowserDriver["open"]>(async (_profile, transport) => {
      expect(transport?.type).toBe("http-proxy");
      return { context, close };
    });

    const host = new ChromeProfileHost(profiles, transports, { open });

    await host.withProfile("xhs-main", "job-1", async (session) => {
      expect(session.context).toBe(context);
    });
    await host.withProfile("xhs-main", "job-2", async () => undefined);

    expect(open).toHaveBeenCalledTimes(1);
    expect(profiles.list()[0]?.activeLeases).toBe(0);

    await host.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
