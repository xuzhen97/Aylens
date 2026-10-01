import { RetrievalError } from "../core/errors.js";
import { createId } from "../shared/ids.js";

export interface BrowserProfileDefinition {
  id: string;
  browser: string;
  mode: "launch" | "cdp";
  persistent: boolean;
  userDataDir: string;
  maxConcurrency: number;
  interactive: boolean;
  headless: boolean;
  channel?: string | undefined;
  executablePath?: string | undefined;
  cdpEndpoint?: string | undefined;
  autoStart?: boolean | undefined;
  args: string[];
  transport?: string | undefined;
}

export interface BrowserProfileLease {
  id: string;
  profileId: string;
  jobId: string;
  acquiredAt: number;
}

export class BrowserProfileManager {
  private readonly profiles = new Map<string, BrowserProfileDefinition>();
  private readonly leases = new Map<string, BrowserProfileLease[]>();

  register(profile: BrowserProfileDefinition): void {
    if (this.profiles.has(profile.id)) throw new Error(`Browser profile already registered: ${profile.id}`);
    this.profiles.set(profile.id, profile);
  }

  get(profileId: string): BrowserProfileDefinition {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new RetrievalError("PROFILE_AUTH_REQUIRED", `Unknown browser profile: ${profileId}`);
    return profile;
  }

  acquire(profileId: string, jobId: string): BrowserProfileLease {
    const profile = this.get(profileId);

    const active = this.leases.get(profileId) ?? [];
    if (active.length >= profile.maxConcurrency) {
      throw new RetrievalError("PROFILE_BUSY", `Browser profile is busy: ${profileId}`, { retryable: true });
    }

    const lease = { id: createId("lease"), profileId, jobId, acquiredAt: Date.now() };
    this.leases.set(profileId, [...active, lease]);
    return lease;
  }

  release(leaseId: string): void {
    for (const [profileId, active] of this.leases) {
      const next = active.filter((lease) => lease.id !== leaseId);
      if (next.length !== active.length) {
        this.leases.set(profileId, next);
        return;
      }
    }
  }

  list(): Array<BrowserProfileDefinition & { activeLeases: number }> {
    return [...this.profiles.values()].map((profile) => ({
      ...profile,
      activeLeases: this.leases.get(profile.id)?.length ?? 0,
    }));
  }
}
