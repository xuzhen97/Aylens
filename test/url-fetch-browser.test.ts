import { tmpdir } from "node:os";

import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { ChromeProfileHost } from "../src/browser/chrome-profile-host.js";
import type { BrowserDriver, BrowserDriverResult } from "../src/browser/chrome-driver.js";
import { BrowserProfileManager } from "../src/browser/profile-manager.js";
import type { BrowserHost, BrowserSession } from "../src/browser/types.js";
import { RetrievalError } from "../src/core/errors.js";
import { createBudget } from "../src/providers/url-fetch/budget.js";
import { fetchBrowserTarget } from "../src/providers/url-fetch/browser-fetch.js";
import { parseOptions } from "../src/providers/url-fetch/options.js";
import type { ProviderContext } from "../src/providers/types.js";
import { TransportRegistry } from "../src/transports/registry.js";

const providerContext: ProviderContext = {
  requestId: "req-1",
  traceId: "trace-1",
  runtimeId: "runner-1",
  jobId: "job-1",
};

const target = new URL("https://example.com/dashboard");

// SAFETY: 这些假对象只实现被测代码实际调用的方法；断言成 Playwright / BrowserHost 类型
// 是为了让被测函数保持真实签名，而不是把生产代码放宽成 any。
function asPage(value: unknown): Page {
  return value as Page;
}

function asHost(value: unknown): BrowserHost {
  return value as BrowserHost;
}

function asSession(value: unknown): BrowserSession {
  return value as BrowserSession;
}

function egressOptions(overrides: Record<string, unknown> = {}) {
  return parseOptions({ controlledBrowserEgress: true, ...overrides });
}

interface FakePageOptions {
  html?: string;
  finalUrl?: string;
  status?: number;
  /** 设置后 goto 挂起，直到页面被关闭才 reject，用于验证取消路径。 */
  hangUntilClosed?: boolean;
}

function createFakePage(options: FakePageOptions = {}) {
  const state = { closed: false, gotoInit: undefined as { waitUntil?: string; timeout?: number } | undefined };
  let rejectGoto: ((error: Error) => void) | undefined;

  const page = {
    url: () => options.finalUrl ?? "https://example.com/rendered",
    goto: (_url: string, init: { waitUntil?: string; timeout?: number }) => {
      state.gotoInit = init;
      return new Promise((resolve, reject) => {
        rejectGoto = reject;
        if (!options.hangUntilClosed) resolve({ status: () => options.status ?? 200 });
      });
    },
    waitForFunction: async () => {
      throw new Error("rendered content did not appear");
    },
    content: async () => options.html ?? "<html><body><p>rendered body</p></body></html>",
    close: async () => {
      state.closed = true;
      rejectGoto?.(new Error("page closed"));
    },
  };

  return { state, page: asPage(page) };
}

function createFakeHost(page: Page) {
  const calls: Array<{ profileId: string; jobId: string; signal: AbortSignal | undefined }> = [];
  const contextClosed = { value: false };

  const host = {
    async withProfile(
      profileId: string,
      jobId: string,
      callback: (session: BrowserSession) => Promise<unknown>,
      options?: { signal?: AbortSignal | undefined },
    ) {
      calls.push({ profileId, jobId, signal: options?.signal });

      const context = {
        newPage: async () => page,
        close: async () => {
          contextClosed.value = true;
        },
      };

      return await callback(asSession({ profileId, context }));
    },
    async close() {},
  };

  return { host: asHost(host), calls, contextClosed };
}

describe("fetchBrowserTarget", () => {
  it("refuses to open a profile when the controlled egress is not confirmed", async () => {
    const { page } = createFakePage();
    const { host, calls } = createFakeHost(page);

    await expect(fetchBrowserTarget(
      host,
      "browser-main",
      providerContext,
      target,
      parseOptions({}),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "NETWORK_POLICY_REJECTED" });

    expect(calls).toHaveLength(0);
  });

  it("reports an unavailable runtime when no browser host is configured", async () => {
    await expect(fetchBrowserTarget(
      undefined,
      "browser-main",
      providerContext,
      target,
      egressOptions(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("navigates with domcontentloaded and keeps the shared context open", async () => {
    const { state, page } = createFakePage({ finalUrl: "https://example.com/dashboard/app" });
    const { host, calls, contextClosed } = createFakeHost(page);

    const result = await fetchBrowserTarget(
      host,
      "browser-main",
      providerContext,
      target,
      egressOptions(),
      new AbortController().signal,
    );

    expect(result.url).toBe("https://example.com/dashboard/app");
    expect(result.status).toBe(200);
    expect(result.html).toContain("rendered body");
    expect(state.gotoInit?.waitUntil).toBe("domcontentloaded");
    expect(state.closed).toBe(true);
    // 持久化 Profile 是共享的：只能关闭本次页面。
    expect(contextClosed.value).toBe(false);
    expect(calls[0]?.profileId).toBe("browser-main");
    expect(calls[0]?.jobId).toBe("job-1");
  });

  it("closes the page on cancellation and reports a retryable timeout", async () => {
    const { state, page } = createFakePage({ hangUntilClosed: true });
    const { host, contextClosed } = createFakeHost(page);

    const controller = new AbortController();
    const pending = fetchBrowserTarget(host, "browser-main", providerContext, target, egressOptions(), controller.signal);
    setTimeout(() => controller.abort(), 20).unref();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(state.closed).toBe(true);
    expect(contextClosed.value).toBe(false);
  });

  it("does not open a profile when the signal is already aborted", async () => {
    const { page } = createFakePage();
    const { host, calls } = createFakeHost(page);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchBrowserTarget(host, "browser-main", providerContext, target, egressOptions(), controller.signal))
      .rejects.toMatchObject({ code: "TIMEOUT" });

    expect(calls).toHaveLength(0);
  });

  it("propagates profile contention instead of queueing", async () => {
    const busyHost = asHost({
      async withProfile() {
        throw new RetrievalError("PROFILE_BUSY", "Browser profile is busy: browser-main", { retryable: true });
      },
      async close() {},
    });

    await expect(fetchBrowserTarget(
      busyHost,
      "browser-main",
      providerContext,
      target,
      egressOptions(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "PROFILE_BUSY", retryable: true });
  });
});

describe("ChromeProfileHost cancellation", () => {
  it("does not enter the callback and still releases the lease when already aborted", async () => {
    const profiles = new BrowserProfileManager();
    profiles.register({
      id: "browser-main",
      browser: "chrome",
      mode: "launch",
      persistent: true,
      userDataDir: tmpdir(),
      maxConcurrency: 1,
      interactive: false,
      headless: true,
      args: [],
    });

    let opened = false;
    const driver: BrowserDriver = {
      async open(): Promise<BrowserDriverResult> {
        opened = true;
        throw new Error("browser must not be launched for an already cancelled request");
      },
    };

    const host = new ChromeProfileHost(profiles, new TransportRegistry(), driver);
    const controller = new AbortController();
    controller.abort();

    let entered = false;

    await expect(host.withProfile(
      "browser-main",
      "job-1",
      async () => {
        entered = true;
        return "unreachable";
      },
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "TIMEOUT" });

    expect(entered).toBe(false);
    expect(opened).toBe(false);
    // 提前返回也必须释放租约，否则 Profile 会被永久占满。
    expect(profiles.list()[0]?.activeLeases).toBe(0);
  });

  it("keeps accepting existing three-argument callers", async () => {
    const profiles = new BrowserProfileManager();
    profiles.register({
      id: "browser-main",
      browser: "chrome",
      mode: "launch",
      persistent: true,
      userDataDir: tmpdir(),
      maxConcurrency: 1,
      interactive: false,
      headless: true,
      args: [],
    });

    const driver: BrowserDriver = {
      async open(): Promise<BrowserDriverResult> {
        return {
          context: asSession({ profileId: "browser-main", context: {} }).context,
          close: async () => undefined,
        };
      },
    };

    const host = new ChromeProfileHost(profiles, new TransportRegistry(), driver);
    await expect(host.withProfile("browser-main", "job-2", async () => "ok")).resolves.toBe("ok");
    expect(profiles.list()[0]?.activeLeases).toBe(0);
  });
});

describe("createBudget", () => {
  it("shares a single deadline across every stage it wraps", async () => {
    const budget = createBudget(undefined, 40);
    expect(budget.remainingMs()).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(budget.signal.aborted).toBe(true);
    expect(budget.remainingMs()).toBe(0);
    budget.dispose();
  });

  it("follows the parent signal and stops listening after dispose", () => {
    const parent = new AbortController();
    const budget = createBudget(parent.signal, 5_000);

    parent.abort();
    expect(budget.signal.aborted).toBe(true);

    budget.dispose();
    expect(budget.remainingMs()).toBeGreaterThan(0);
  });
});
