import { RetrievalError } from "../core/errors.js";
import type { TransportRegistry } from "../transports/registry.js";
import type { BrowserHost, BrowserSession } from "./types.js";
import type { BrowserDriver, BrowserDriverResult } from "./chrome-driver.js";
import { PlaywrightChromeDriver } from "./chrome-driver.js";
import type { BrowserProfileManager } from "./profile-manager.js";

export class ChromeProfileHost implements BrowserHost {
  private readonly opened = new Map<string, BrowserDriverResult>();
  private readonly opening = new Map<string, Promise<BrowserDriverResult>>();

  constructor(
    private readonly profiles: BrowserProfileManager,
    private readonly transports: TransportRegistry,
    private readonly driver: BrowserDriver = new PlaywrightChromeDriver(),
  ) {}

  async withProfile<T>(
    profileId: string,
    jobId: string,
    callback: (session: BrowserSession) => Promise<T>,
  ): Promise<T> {
    const lease = this.profiles.acquire(profileId, jobId);

    try {
      const handle = await this.ensureOpen(profileId);
      return await callback({ profileId, context: handle.context });
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
  }

  private async ensureOpen(profileId: string): Promise<BrowserDriverResult> {
    const existing = this.opened.get(profileId);
    if (existing) return existing;

    const inFlight = this.opening.get(profileId);
    if (inFlight) return inFlight;

    const profile = this.profiles.get(profileId);
    const transport = profile.transport ? this.transports.getConfig(profile.transport) : undefined;

    const opening = this.driver.open(profile, transport)
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
