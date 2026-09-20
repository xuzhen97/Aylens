import type { BrowserContext } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { providerSchema } from "../src/config/schema.js";
import type { BrowserHost, BrowserSession } from "../src/browser/types.js";
import { TransportRegistry } from "../src/transports/registry.js";
import { loadProviderPlugins } from "../src/providers/plugin.js";

async function genericFactory() {
  const loaded = await loadProviderPlugins(
    ["./plugins/generic-browser/index.mjs"],
    process.cwd(),
  );
  const factory = loaded.factories.find((candidate) => candidate.type === "generic-browser");
  if (!factory) throw new Error("generic-browser factory was not loaded");
  return factory;
}

function fakeBrowser(page: object) {
  const calls: Array<{ profileId: string; jobId: string }> = [];

  const browser: BrowserHost = {
    async withProfile<T>(
      profileId: string,
      jobId: string,
      callback: (session: BrowserSession) => Promise<T>,
    ): Promise<T> {
      calls.push({ profileId, jobId });
      return callback({
        profileId,
        context: {
          newPage: async () => page,
        } as unknown as BrowserContext,
      });
    },
    close: async () => undefined,
  };

  return { browser, calls };
}

describe("generic-browser provider", () => {
  it("opens a URL with the configured profile and returns normalized page content", async () => {
    const close = vi.fn(async () => undefined);
    const goto = vi.fn(async () => ({ status: () => 200 }));
    const body = `  Hello    world\n\n\n${"x".repeat(1100)}  `;

    const page = {
      goto,
      waitForTimeout: vi.fn(async () => undefined),
      title: vi.fn(async () => "  Example   title  "),
      url: vi.fn(() => "https://example.com/final"),
      locator: vi.fn(() => ({
        first: () => ({
          innerText: async () => body,
        }),
      })),
      close,
    };

    const { browser, calls } = fakeBrowser(page);
    const factory = await genericFactory();
    const provider = factory.create(
      "generic-browser",
      providerSchema.parse({
        type: "generic-browser",
        enabled: true,
        runtime: { nodeId: "runner-1" },
        browser: { profile: "generic-login" },
        options: {
          maxTextChars: 1000,
          snippetChars: 100,
          keepPageOpen: false,
        },
      }),
      {
        transports: new TransportRegistry(),
        browser,
      },
    );

    const result = await provider.search(
      {
        requestId: "request-1",
        traceId: "trace-1",
        runtimeId: "runner-1",
        jobId: "job-1",
      },
      { query: "https://example.com/start" },
    );

    expect(calls).toEqual([
      { profileId: "generic-login", jobId: "job-1" },
    ]);
    expect(goto).toHaveBeenCalledWith(
      "https://example.com/start",
      expect.objectContaining({
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe("https://example.com/final");
    expect(result.items[0]?.title).toBe("Example title");
    expect(result.items[0]?.text?.startsWith("Hello world\n\n")).toBe(true);
    expect(result.items[0]?.text).toHaveLength(1000);
    expect(result.items[0]?.snippet).toHaveLength(100);
    expect(result.items[0]?.extensions).toMatchObject({
      requestedUrl: "https://example.com/start",
      profileId: "generic-login",
      httpStatus: 200,
      truncated: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the page open when requested for interactive login bootstrapping", async () => {
    const close = vi.fn(async () => undefined);
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      waitForTimeout: vi.fn(async () => undefined),
      title: vi.fn(async () => "Login"),
      url: vi.fn(() => "https://example.com/login"),
      locator: vi.fn(() => ({
        first: () => ({
          innerText: async () => "Please sign in",
        }),
      })),
      close,
    };

    const { browser } = fakeBrowser(page);
    const factory = await genericFactory();
    const provider = factory.create(
      "generic-browser",
      providerSchema.parse({
        type: "generic-browser",
        browser: { profile: "generic-login" },
        options: { keepPageOpen: true },
      }),
      { transports: new TransportRegistry(), browser },
    );

    await provider.search(
      {
        requestId: "request-2",
        traceId: "trace-2",
        runtimeId: "runner-1",
        jobId: "job-2",
      },
      { query: "https://example.com/login" },
    );

    expect(close).not.toHaveBeenCalled();
  });

  it("rejects non-http URLs with a structured error", async () => {
    const { browser } = fakeBrowser({});
    const factory = await genericFactory();
    const provider = factory.create(
      "generic-browser",
      providerSchema.parse({
        type: "generic-browser",
        browser: { profile: "generic-login" },
        options: {},
      }),
      { transports: new TransportRegistry(), browser },
    );

    await expect(
      provider.search(
        {
          requestId: "request-3",
          traceId: "trace-3",
          runtimeId: "runner-1",
          jobId: "job-3",
        },
        { query: "file:///C:/secret.txt" },
      ),
    ).rejects.toMatchObject({
      code: "URL_FORBIDDEN",
      retryable: false,
    });
  });

  it("fails structurally when the runtime has no BrowserHost", async () => {
    const factory = await genericFactory();

    expect(() => factory.create(
      "generic-browser",
      providerSchema.parse({
        type: "generic-browser",
        browser: { profile: "generic-login" },
        options: {},
      }),
      { transports: new TransportRegistry() },
    )).toThrowError(expect.objectContaining({
      code: "PROVIDER_UNAVAILABLE",
    }));
  });
});
