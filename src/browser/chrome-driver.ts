import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { platform } from "node:os";
import { chromium, type BrowserContext } from "playwright-core";
import type { BrowserProfileDefinition } from "./profile-manager.js";
import type { TransportConfig } from "../config/schema.js";

type PersistentContextOptions =
  NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export interface BrowserDriverResult {
  context: BrowserContext;
  close: () => Promise<void>;
  isConnected?: (() => boolean) | undefined;
}

export interface BrowserDriver {
  /** 进入自动化任务前释放该 Profile 的临时交互式 Chrome。 */
  prepareForAutomation?(profile: BrowserProfileDefinition): Promise<void>;
  open(
    profile: BrowserProfileDefinition,
    transport?: TransportConfig,
  ): Promise<BrowserDriverResult>;
  /** 返回 true 表示 URL 已由普通浏览器进程直接打开，不需要 Playwright fallback。 */
  openInteractive?(
    profile: BrowserProfileDefinition,
    url: string,
    transport?: TransportConfig,
  ): Promise<boolean>;
  /** 清理 Driver 自己启动的临时交互式浏览器；不能影响外部/用户浏览器。 */
  close?(): Promise<void>;
}

export interface ChromeProcessController {
  spawn(executable: string, args: string[]): ChildProcess;
  requestClose(child: ChildProcess): Promise<void>;
  waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean>;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function cdpHttpEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`CDP endpoint must use http:// or https://: ${value}`);
  }
  return endpoint;
}

async function endpointReady(value: string): Promise<boolean> {
  try {
    const url = new URL("/json/version", cdpHttpEndpoint(value));
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths: Array<string | undefined>): Promise<string | undefined> {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续尝试下一个系统安装位置。
    }
  }
  return undefined;
}

export async function resolveChromeExecutable(explicit?: string): Promise<string> {
  if (explicit) return resolve(explicit);
  if (process.env.CHROME_PATH) return resolve(process.env.CHROME_PATH);

  const os = platform();
  const candidates = os === "win32"
    ? [
        process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
        process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      ]
    : os === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];

  const found = await firstExistingPath(candidates);
  if (found) return found;
  throw new Error("Google Chrome executable was not found; set browserProfiles.<id>.executablePath or CHROME_PATH");
}

export function toChromeProxyServer(config: TransportConfig | undefined): string | undefined {
  if (!config || config.type === "direct") return undefined;

  const proxy = new URL(config.url);
  if (proxy.username || proxy.password) {
    throw new Error("Managed CDP Chrome proxy does not support credentials in proxy URL");
  }

  const protocol = config.type === "socks5" ? "socks5:" : proxy.protocol;
  return `${protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}`;
}

export function buildManagedCdpChromeArgs(
  profile: BrowserProfileDefinition,
  transport?: TransportConfig,
): string[] {
  if (!profile.cdpEndpoint) throw new Error(`Browser profile requires cdpEndpoint: ${profile.id}`);
  const endpoint = cdpHttpEndpoint(profile.cdpEndpoint);
  const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  const userDataDir = resolve(profile.userDataDir);
  const proxyServer = toChromeProxyServer(transport);

  return [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${endpoint.hostname}`,
    `--user-data-dir=${userDataDir}`,
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
    ...profile.args,
  ];
}

export function buildInteractiveChromeArgs(
  profile: BrowserProfileDefinition,
  transport: TransportConfig | undefined,
  url: string,
): string[] {
  const proxyServer = toChromeProxyServer(transport);
  return [
    `--user-data-dir=${resolve(profile.userDataDir)}`,
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
    "--new-window",
    url,
  ];
}

function spawnDetachedChrome(executable: string, args: string[]) {
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child;
}

interface InteractiveChromeProcess {
  child: ChildProcess;
  profileId: string;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function requestChromeWindowClose(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  if (platform() === "win32") {
    // Windows 的 SIGTERM 等价于强制 TerminateProcess。先调用 CloseMainWindow，
    // 给 Chrome 正常刷新 Cookie/Profile 数据并退出的机会。
    const command = [
      `$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue;`,
      `if ($p) { [void]$p.CloseMainWindow() }`,
    ].join(" ");
    const closer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolveClose) => {
      closer.once("exit", () => resolveClose());
      closer.once("error", () => resolveClose());
    });
    return;
  }

  child.kill("SIGTERM");
}

const defaultProcessController: ChromeProcessController = {
  spawn: spawnDetachedChrome,
  requestClose: requestChromeWindowClose,
  waitForExit,
};

async function ensureManagedChrome(
  profile: BrowserProfileDefinition,
  transport?: TransportConfig,
  initialUrl?: string,
): Promise<void> {
  if (!profile.cdpEndpoint) throw new Error(`Browser profile requires cdpEndpoint: ${profile.id}`);

  const executable = await resolveChromeExecutable(profile.executablePath);
  if (await endpointReady(profile.cdpEndpoint)) {
    if (initialUrl) {
      spawnDetachedChrome(executable, [
        `--user-data-dir=${resolve(profile.userDataDir)}`,
        initialUrl,
      ]);
    }
    return;
  }

  const child = spawnDetachedChrome(executable, [
    ...buildManagedCdpChromeArgs(profile, transport),
    ...(initialUrl ? [initialUrl] : []),
  ]);
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (await endpointReady(profile.cdpEndpoint)) return;
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became ready: exitCode=${child.exitCode}`);
    }
    await delay(200);
  }

  throw new Error(
    `Chrome CDP endpoint did not become ready: ${profile.cdpEndpoint}. ` +
    "The browser profile may still be locked by another Chrome process.",
  );
}

export class PlaywrightChromeDriver implements BrowserDriver {
  private readonly interactive = new Map<string, InteractiveChromeProcess>();

  constructor(private readonly processes: ChromeProcessController = defaultProcessController) {}

  private async stopInteractive(profileId: string): Promise<void> {
    const managed = this.interactive.get(profileId);
    if (!managed) return;

    const { child } = managed;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.interactive.delete(profileId);
      return;
    }

    await this.processes.requestClose(child);
    if (await this.processes.waitForExit(child, 5_000)) {
      if (this.interactive.get(profileId)?.child === child) this.interactive.delete(profileId);
      await delay(250);
      return;
    }

    // 只强制结束我们自己保存过 PID 的 Chrome。不会扫描或终止用户的日常 Chrome。
    child.kill();
    if (!await this.processes.waitForExit(child, 3_000)) {
      throw new Error(`Interactive Chrome did not exit for profile: ${profileId}`);
    }
    if (this.interactive.get(profileId)?.child === child) this.interactive.delete(profileId);
    await delay(250);
  }

  async prepareForAutomation(profile: BrowserProfileDefinition): Promise<void> {
    await this.stopInteractive(profile.id);
  }

  async openInteractive(
    profile: BrowserProfileDefinition,
    url: string,
    transport?: TransportConfig,
  ): Promise<boolean> {
    if (profile.mode !== "cdp" || !profile.autoStart) return false;
    if (!profile.cdpEndpoint) throw new Error(`Browser profile requires cdpEndpoint: ${profile.id}`);

    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`Interactive browser URL must use http:// or https://: ${url}`);
    }

    if (await endpointReady(profile.cdpEndpoint)) {
      throw new Error(
        `Browser profile ${profile.id} is currently running in CDP mode. ` +
        "Close that Chrome window before starting a normal interactive login.",
      );
    }

    const executable = await resolveChromeExecutable(profile.executablePath);
    await this.stopInteractive(profile.id);
    const child = this.processes.spawn(
      executable,
      buildInteractiveChromeArgs(profile, transport, target.toString()),
    );
    this.interactive.set(profile.id, { child, profileId: profile.id });
    child.once("exit", () => {
      const current = this.interactive.get(profile.id);
      if (current?.child === child) this.interactive.delete(profile.id);
    });
    return true;
  }

  async open(
    profile: BrowserProfileDefinition,
    transport?: TransportConfig,
  ): Promise<BrowserDriverResult> {
    if (profile.mode === "cdp") {
      if (!profile.cdpEndpoint) {
        throw new Error(`Browser profile requires cdpEndpoint: ${profile.id}`);
      }
      if (profile.autoStart) await ensureManagedChrome(profile, transport);

      const browser = await chromium.connectOverCDP(profile.cdpEndpoint);
      const context = browser.contexts()[0];

      if (!context) {
        throw new Error(`CDP browser has no default context: ${profile.id}`);
      }

      return {
        context,
        isConnected: () => browser.isConnected(),
        // connectOverCDP 得到的是已连接 Browser；close 只断开 Playwright 连接，
        // 普通 Chrome 进程继续运行并保存自己的登录状态。
        close: async () => browser.close(),
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

  async close(): Promise<void> {
    const profileIds = [...this.interactive.keys()];
    await Promise.allSettled(profileIds.map((profileId) => this.stopInteractive(profileId)));
  }
}
