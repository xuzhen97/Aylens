import { describe, expect, it } from "vitest";
import { BrowserProfileManager } from "../src/browser/profile-manager.js";
import { RetrievalError } from "../src/core/errors.js";

describe("BrowserProfileManager", () => {
  it("leases a single-concurrency profile and releases it", () => {
    const manager = new BrowserProfileManager();
    manager.register({
      id: "xhs-main",
      browser: "chrome",
      mode: "launch",
      persistent: true,
      userDataDir: "D:/profiles/xhs-main",
      maxConcurrency: 1,
      interactive: true,
      headless: false,
      channel: "chrome",
      args: [],
    });

    const lease = manager.acquire("xhs-main", "job-1");

    expect(() => manager.acquire("xhs-main", "job-2")).toThrowError(RetrievalError);
    manager.release(lease.id);
    expect(manager.acquire("xhs-main", "job-2").profileId).toBe("xhs-main");
  });
});
