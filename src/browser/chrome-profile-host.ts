import { RetrievalError } from "../core/errors.js";
import type { TransportRegistry } from "../transports/registry.js";
import type { BrowserHost, BrowserSession } from "./types.js";
import type { BrowserDriver, BrowserDriverResult } from "./chrome-driver.js";
import { PlaywrightChromeDriver } from "./chrome-driver.js";
import type { BrowserProfileManager } from "./profile-manager.js";

function browserCancelledError(): RetrievalError {
  return new RetrievalError("TIMEOUT", "Browser session was cancelled", { retryable: true });
}

export class ChromeProfileHost implements BrowserHost {
  private readonly opened = new Map<string, BrowserDriverResult>();
  private readonly opening = new Map<string, Promise<BrowserDriverResult>>();

  constructor(
    private readonly profiles: BrowserProfileManager,
    private readonly transports: TransportRegistry,
    private readonly driver: BrowserDriver = new PlaywrightChromeDriver(),
  ) {}

  /**
   * 返回绑定到指定 Registry 的轻量 facade:共享同一 ProfileManager、driver、
   * opened/opening 缓存与 lease 生命周期,仅在打开浏览器时使用快照内的代理配置。
   * 已打开的 Chrome 不受影响,也不会因快照切换被关闭。
   */
  forTransports(transports: TransportRegistry): BrowserHost {
    const facade = Object.create(this) as ChromeProfileHost;
    Object.defineProperty(facade, "transports", { value: transports });
    return facade;
  }

  async withProfile<T>(
    profileId: string,
    jobId: string,
    callback: (session: BrowserSession) => Promise<T>,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) throw browserCancelledError();

    const lease = this.profiles.acquire(profileId, jobId);
    const profile = this.profiles.get(profileId);
    let handle: BrowserDriverResult | undefined;

    try {
      handle = await this.ensureOpen(profileId);

      // 启动过程无法安全中断，但取消后绝不能进入 callback，也不能遗留未跟踪的后台操作。
      if (signal?.aborted) throw browserCancelledError();

      return await callback({ profileId, context: handle.context });
    } finally {
      // CDP 只在真实任务执行期间 attach；完成后立即断开 Playwright，Chrome 本身保持运行。
      if (handle && profile.mode === "cdp") {
        if (this.opened.get(profileId) === handle) this.opened.delete(profileId);
        await handle.close().catch(() => undefined);
      }
      this.profiles.release(lease.id);
    }
  }

  async openInteractive(profileId: string, jobId: string, url: string): Promise<void> {
    const lease = this.profiles.acquire(profileId, jobId);
    const profile = this.profiles.get(profileId);
    const transport = profile.transport ? this.transports.getConfig(profile.transport) : undefined;

    try {
      if (this.driver.openInteractive && await this.driver.openInteractive(profile, url, transport)) return;

      // 兼容未托管的 CDP / launch Profile：无法直接交给系统 Chrome 时才使用自动化 fallback。
      const handle = await this.ensureOpen(profileId);
      try {
        const page = await handle.context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.bringToFront().catch(() => undefined);
      } finally {
        if (profile.mode === "cdp") {
          if (this.opened.get(profileId) === handle) this.opened.delete(profileId);
          await handle.close().catch(() => undefined);
        }
      }
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError(
        "BROWSER_START_FAILED",
        `Failed to open interactive browser profile: ${profileId}`,
        { retryable: true, cause: error },
      );
    } finally {
      this.profiles.release(lease.id);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.opening.values()]);
    const handles = [...this.opened.values()];
    this.opened.clear();
    this.opening.clear();
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await this.driver.close?.();
  }

  private async ensureOpen(profileId: string): Promise<BrowserDriverResult> {
    const existing = this.opened.get(profileId);
    if (existing) {
      if (!existing.isConnected || existing.isConnected()) return existing;
      this.opened.delete(profileId);
    }

    const inFlight = this.opening.get(profileId);
    if (inFlight) return inFlight;

    const profile = this.profiles.get(profileId);
    const transport = profile.transport ? this.transports.getConfig(profile.transport) : undefined;

    const opening = Promise.resolve()
      .then(async () => {
        await this.driver.prepareForAutomation?.(profile);
        return this.driver.open(profile, transport);
      })
      .then((handle) => {
        this.opened.set(profileId, handle);
        this.opening.delete(profileId);
        return handle;
      })
      .catch((error: unknown) => {
        this.opening.delete(profileId);
        throw new RetrievalError(
          "BROWSER_START_FAILED",
          `Failed to open browser profile: ${profileId}`,
          { retryable: true, cause: error },
        );
      });

    this.opening.set(profileId, opening);
    return opening;
  }
}
