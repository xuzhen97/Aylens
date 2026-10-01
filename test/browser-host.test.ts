import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { BrowserContext } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { BrowserProfileManager, type BrowserProfileDefinition } from "../src/browser/profile-manager.js";
import { ChromeProfileHost } from "../src/browser/chrome-profile-host.js";
import {
  buildInteractiveChromeArgs,
  buildManagedCdpChromeArgs,
  PlaywrightChromeDriver,
  toChromeProxyServer,
  toPlaywrightProxySettings,
  type BrowserDriver,
  type ChromeProcessController,
} from "../src/browser/chrome-driver.js";
import { TransportRegistry } from "../src/transports/registry.js";
import { HttpProxyTransportFactory } from "../src/transports/http-proxy.js";

function fakeChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid, writable: false });
  Object.defineProperty(child, "exitCode", { value: null, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, writable: true });
  child.kill = vi.fn(() => true);
  return child;
}

function cdpProfile(): BrowserProfileDefinition {
  return {
    id: "browser-main",
    browser: "chrome",
    mode: "cdp",
    persistent: true,
    userDataDir: "./.profiles/browser-main",
    maxConcurrency: 1,
    interactive: true,
    headless: false,
    executablePath: "C:/fake/chrome.exe",
    cdpEndpoint: "http://127.0.0.1:1",
    autoStart: true,
    args: [],
  };
}

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

  it("builds normal Chrome CDP arguments around the persistent user data directory", () => {
    const profile: BrowserProfileDefinition = {
      id: "browser-main",
      browser: "chrome",
      mode: "cdp",
      persistent: true,
      userDataDir: "./.profiles/browser-main",
      maxConcurrency: 1,
      interactive: true,
      headless: false,
      cdpEndpoint: "http://127.0.0.1:9222",
      autoStart: true,
      args: ["--lang=zh-CN"],
    };
    const args = buildManagedCdpChromeArgs(profile, {
      type: "http-proxy",
      url: "http://127.0.0.1:10808",
    });

    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);
    expect(args).toContain("--proxy-server=http://127.0.0.1:10808");
    expect(args).toContain("--lang=zh-CN");
    expect(args).not.toContain("--enable-automation");
  });

  it("maps SOCKS5 transports to a Chrome proxy server", () => {
    expect(toChromeProxyServer({
      type: "socks5",
      url: "socks5h://127.0.0.1:10808",
    })).toBe("socks5://127.0.0.1:10808");
  });

  it("builds a normal interactive Chrome login without CDP flags while preserving proxy", () => {
    const profile: BrowserProfileDefinition = {
      id: "browser-main",
      browser: "chrome",
      mode: "cdp",
      persistent: true,
      userDataDir: "./.profiles/browser-main",
      maxConcurrency: 1,
      interactive: true,
      headless: false,
      cdpEndpoint: "http://127.0.0.1:9222",
      autoStart: true,
      args: [],
    };
    const args = buildInteractiveChromeArgs(
      profile,
      { type: "http-proxy", url: "http://127.0.0.1:10808" },
      "https://x.com/login",
    );

    expect(args).toContain("--proxy-server=http://127.0.0.1:10808");
    expect(args).toContain("--new-window");
    expect(args).toContain("https://x.com/login");
    expect(args.some((arg) => arg.startsWith("--remote-debugging-"))).toBe(false);
    expect(args).not.toContain("--enable-automation");
  });
});

describe("ChromeProfileHost", () => {
  it("prepares a managed interactive profile before opening the automation session", async () => {
    const profiles = new BrowserProfileManager();
    profiles.register(cdpProfile());
    const transports = new TransportRegistry();
    const context = {} as BrowserContext;
    const prepareForAutomation = vi.fn(async () => undefined);
    const open = vi.fn<BrowserDriver["open"]>(async () => ({
      context,
      close: async () => undefined,
    }));
    const host = new ChromeProfileHost(profiles, transports, {
      prepareForAutomation,
      open,
    });

    await host.withProfile("browser-main", "job-check", async () => undefined);

    expect(prepareForAutomation).toHaveBeenCalledWith(expect.objectContaining({ id: "browser-main" }));
    expect(prepareForAutomation.mock.invocationCallOrder[0])
      .toBeLessThan(open.mock.invocationCallOrder[0]!);
  });

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

  it("reopens a CDP profile after the external Chrome connection is lost", async () => {
    const profiles = new BrowserProfileManager();
    profiles.register({
      id: "browser-main",
      browser: "chrome",
      mode: "cdp",
      persistent: true,
      userDataDir: "./.profiles/browser-main",
      maxConcurrency: 1,
      interactive: true,
      headless: false,
      cdpEndpoint: "http://127.0.0.1:9222",
      autoStart: true,
      args: [],
    });
    const transports = new TransportRegistry();
    const context = {} as BrowserContext;
    let connected = true;
    const open = vi.fn<BrowserDriver["open"]>(async () => ({
      context,
      isConnected: () => connected,
      close: async () => undefined,
    }));
    const host = new ChromeProfileHost(profiles, transports, { open });

    await host.withProfile("browser-main", "job-1", async () => undefined);
    connected = false;
    await host.withProfile("browser-main", "job-2", async () => undefined);

    expect(open).toHaveBeenCalledTimes(2);
    await host.close();
  });

  it("opens managed-CDP login pages without attaching Playwright first", async () => {
    const profiles = new BrowserProfileManager();
    profiles.register({
      id: "browser-main",
      browser: "chrome",
      mode: "cdp",
      persistent: true,
      userDataDir: "./.profiles/browser-main",
      maxConcurrency: 1,
      interactive: true,
      headless: false,
      cdpEndpoint: "http://127.0.0.1:9222",
      autoStart: true,
      args: [],
      transport: "proxy-local",
    });
    const transports = new TransportRegistry();
    transports.registerFactory(new HttpProxyTransportFactory());
    transports.build("proxy-local", {
      type: "http-proxy",
      url: "http://127.0.0.1:10808",
    });
    const open = vi.fn<BrowserDriver["open"]>(async () => {
      throw new Error("automation attach should not happen during login");
    });
    const openInteractive = vi.fn(async () => true);
    const host = new ChromeProfileHost(profiles, transports, { open, openInteractive });

    await host.openInteractive("browser-main", "job-login", "https://x.com/login");

    expect(openInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "browser-main", mode: "cdp", autoStart: true }),
      "https://x.com/login",
      { type: "http-proxy", url: "http://127.0.0.1:10808" },
    );
    expect(open).not.toHaveBeenCalled();
  });
});

describe("PlaywrightChromeDriver interactive lifecycle", () => {
  it("closes the Aylens-started login Chrome before automation starts", async () => {
    const child = fakeChild();
    const requestClose = vi.fn(async () => undefined);
    const waitForExit = vi.fn(async () => true);
    const controller: ChromeProcessController = {
      spawn: vi.fn(() => child),
      requestClose,
      waitForExit,
    };
    const driver = new PlaywrightChromeDriver(controller);
    const profile = cdpProfile();

    await driver.openInteractive(
      profile,
      "https://x.com/login",
      { type: "http-proxy", url: "http://127.0.0.1:10808" },
    );
    await driver.prepareForAutomation(profile);

    expect(requestClose).toHaveBeenCalledWith(child);
    expect(waitForExit).toHaveBeenCalledWith(child, 5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fails instead of opening CDP when the interactive Chrome cannot be stopped", async () => {
    const child = fakeChild();
    const controller: ChromeProcessController = {
      spawn: vi.fn(() => child),
      requestClose: vi.fn(async () => undefined),
      waitForExit: vi.fn(async () => false),
    };
    const driver = new PlaywrightChromeDriver(controller);
    const profile = cdpProfile();

    await driver.openInteractive(profile, "https://x.com/login");
    await expect(driver.prepareForAutomation(profile))
      .rejects.toThrow("Interactive Chrome did not exit for profile: browser-main");
    expect(child.kill).toHaveBeenCalledOnce();

    // 失败后仍保留进程追踪，下一次可以继续尝试清理，而不是丢失控制权。
    await expect(driver.prepareForAutomation(profile))
      .rejects.toThrow("Interactive Chrome did not exit for profile: browser-main");
  });
});
