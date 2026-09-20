import type { BrowserContext } from "playwright-core";

export interface BrowserSession {
  profileId: string;
  context: BrowserContext;
}

export interface BrowserHost {
  withProfile<T>(
    profileId: string,
    jobId: string,
    callback: (session: BrowserSession) => Promise<T>,
  ): Promise<T>;

  close(): Promise<void>;
}
