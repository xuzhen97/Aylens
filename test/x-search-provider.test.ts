import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { providerDeploymentSchema } from "../src/config/schema.js";
import type { BrowserHost, BrowserSession } from "../src/browser/types.js";
import { TransportRegistry } from "../src/transports/registry.js";
import { xSearchFactory } from "../src/providers/x-search/index.js";

function fakeBrowser(page: Page) {
  const calls: Array<{ profileId: string; jobId: string }> = [];
  const context = {
    newPage: async () => page,
    pages: () => [page],
  } as unknown as BrowserContext;

  const browser: BrowserHost = {
    async withProfile<T>(
      profileId: string,
      jobId: string,
      callback: (session: BrowserSession) => Promise<T>,
    ): Promise<T> {
      calls.push({ profileId, jobId });
      return callback({ profileId, context });
    },
    close: async () => undefined,
  };

  return { browser, calls };
}

function authenticatedPage() {
  let currentUrl = "about:blank";
  const close = vi.fn(async () => undefined);
  const bringToFront = vi.fn(async () => undefined);
  const goto = vi.fn(async (url: string) => {
    currentUrl = url;
    return { status: () => 200 };
  });

  const locator = vi.fn((selector: string) => {
    if (selector === 'input[autocomplete="username"]') {
      return { count: async () => 0 };
    }
    if (selector === 'a[data-testid="AppTabBar_Profile_Link"]') {
      return {
        first: () => ({
          getAttribute: async () => "/demo",
        }),
      };
    }
    if (selector === '[data-testid="SideNav_AccountSwitcher_Button"]') {
      return {
        first: () => ({
          innerText: async () => "Demo User\n@demo",
        }),
      };
    }
    if (selector.includes("SideNav_NewTweet_Button")) {
      return { count: async () => 1 };
    }
    if (selector === 'article[data-testid="tweet"]') {
      return {
        evaluateAll: async () => [{
          href: "/alice/status/123456789",
          text: "hello from x",
          publishedAt: "2026-09-30T10:00:00.000Z",
          userNameText: "Alice\n@alice",
        }],
      };
    }
    throw new Error(`unexpected selector: ${selector}`);
  });

  const page = {
    goto,
    url: () => currentUrl,
    locator,
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    close,
    bringToFront,
  } as unknown as Page;

  return { page, goto, close, bringToFront };
}

describe("x-search provider", () => {
  it("reuses the default profile, reports the logged-in account, and returns X posts", async () => {
    const { page } = authenticatedPage();
    const { browser, calls } = fakeBrowser(page);
    const reportAuthState = vi.fn();
    const provider = xSearchFactory.create(
      "x",
      providerDeploymentSchema.parse({
        type: "x-search",
        options: { postLoadDelayMs: 0, maxScrolls: 0 },
      }),
      {
        transports: new TransportRegistry(),
        browser,
        defaultBrowserProfile: "browser-main",
        reportAuthState,
      },
    );

    const result = await provider.search(
      {
        requestId: "request-x",
        traceId: "trace-x",
        runtimeId: "runner-x",
        jobId: "job-x",
      },
      { query: '"OpenAI" lang:en', limit: 5 },
    );

    expect(calls).toEqual([{ profileId: "browser-main", jobId: "job-x" }]);
    expect(reportAuthState).toHaveBeenCalledWith(expect.objectContaining({
      status: "authenticated",
      account: { handle: "@demo", displayName: "Demo User" },
    }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      platform: "x",
      type: "post",
      url: "https://x.com/alice/status/123456789",
      text: "hello from x",
      publishedAt: "2026-09-30T10:00:00.000Z",
      provenance: {
        provider: "x",
        providerItemId: "123456789",
        retrievalMethod: "browser",
        runtimeId: "runner-x",
      },
      extensions: {
        author: { handle: "@alice", displayName: "Alice" },
        resultMode: "latest",
      },
    });
  });

  it("marks the profile as auth-required when X redirects search to login", async () => {
    let currentUrl = "about:blank";
    const page = {
      goto: vi.fn(async () => {
        currentUrl = "https://x.com/i/flow/login";
        return { status: () => 200 };
      }),
      url: () => currentUrl,
      locator: vi.fn(() => {
        throw new Error("login URL should be enough to detect auth-required");
      }),
      waitForTimeout: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as Page;
    const { browser } = fakeBrowser(page);
    const reportAuthState = vi.fn();
    const provider = xSearchFactory.create(
      "x",
      providerDeploymentSchema.parse({
        type: "x-search",
        options: { postLoadDelayMs: 0 },
      }),
      {
        transports: new TransportRegistry(),
        browser,
        defaultBrowserProfile: "browser-main",
        reportAuthState,
      },
    );

    await expect(provider.search(
      {
        requestId: "request-login",
        traceId: "trace-login",
        runtimeId: "runner-x",
        jobId: "job-login",
      },
      { query: "openai" },
    )).rejects.toMatchObject({ code: "PROFILE_AUTH_REQUIRED" });

    expect(reportAuthState).toHaveBeenCalledWith(expect.objectContaining({
      status: "auth_required",
    }));
  });

  it("opens the real X login page without closing it", async () => {
    let currentUrl = "about:blank";
    const close = vi.fn(async () => undefined);
    const bringToFront = vi.fn(async () => undefined);
    const page = {
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
        return { status: () => 200 };
      }),
      url: () => currentUrl,
      locator: vi.fn((selector: string) => {
        if (selector === 'input[autocomplete="username"]') return { count: async () => 1 };
        throw new Error(`unexpected selector: ${selector}`);
      }),
      waitForTimeout: vi.fn(async () => undefined),
      bringToFront,
      close,
    } as unknown as Page;
    const { browser } = fakeBrowser(page);
    const provider = xSearchFactory.create(
      "x",
      providerDeploymentSchema.parse({ type: "x-search" }),
      {
        transports: new TransportRegistry(),
        browser,
        defaultBrowserProfile: "browser-main",
      },
    );

    const state = await provider.openLogin?.({
      requestId: "auth-login",
      traceId: "trace-login",
      runtimeId: "runner-x",
      jobId: "job-login-page",
    });

    expect(currentUrl).toBe("https://x.com/login");
    expect(bringToFront).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(state).toMatchObject({ status: "auth_required" });
  });

  it("prefers the BrowserHost interactive path for X login without an automation session", async () => {
    const openInteractive = vi.fn(async () => undefined);
    const withProfile = vi.fn(async () => {
      throw new Error("withProfile should not run for interactive login");
    });
    const browser: BrowserHost = {
      withProfile: withProfile as BrowserHost["withProfile"],
      openInteractive,
      close: async () => undefined,
    };
    const reportAuthState = vi.fn();
    const provider = xSearchFactory.create(
      "x",
      providerDeploymentSchema.parse({ type: "x-search" }),
      {
        transports: new TransportRegistry(),
        browser,
        defaultBrowserProfile: "browser-main",
        reportAuthState,
      },
    );

    const state = await provider.openLogin?.({
      requestId: "auth-interactive",
      traceId: "trace-interactive",
      runtimeId: "runner-x",
      jobId: "job-interactive",
    });

    expect(openInteractive).toHaveBeenCalledWith(
      "browser-main",
      "job-interactive",
      "https://x.com/login",
    );
    expect(withProfile).not.toHaveBeenCalled();
    expect(reportAuthState).toHaveBeenCalledWith(expect.objectContaining({ status: "auth_required" }));
    expect(state).toMatchObject({ status: "auth_required" });
  });
});
