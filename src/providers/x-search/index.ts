import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import type { ProviderDeploymentConfig } from "../../config/schema.js";
import { RetrievalError } from "../../core/errors.js";
import type {
  ProviderAuthAccount,
  ProviderAuthState,
  ProviderFactory,
} from "../types.js";

const X_ORIGIN = "https://x.com";
const X_HOME_URL = `${X_ORIGIN}/home`;
const X_LOGIN_URL = `${X_ORIGIN}/login`;
const LOGIN_PATHS = new Set(["/login", "/i/flow/login"]);

interface XOptions {
  timeoutMs: number;
  authTimeoutMs: number;
  postLoadDelayMs: number;
  scrollDelayMs: number;
  maxScrolls: number;
}

interface RawPost {
  href: string;
  text: string;
  publishedAt?: string;
  userNameText?: string;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function optionsFrom(config: ProviderDeploymentConfig): XOptions {
  const options = config.options ?? {};
  return {
    timeoutMs: boundedNumber(options.timeoutMs, 30_000, 1_000, 120_000),
    authTimeoutMs: boundedNumber(options.authTimeoutMs, 10_000, 1_000, 60_000),
    postLoadDelayMs: boundedNumber(options.postLoadDelayMs, 800, 0, 30_000),
    scrollDelayMs: boundedNumber(options.scrollDelayMs, 800, 100, 10_000),
    maxScrolls: boundedNumber(options.maxScrolls, 20, 0, 100),
  };
}

function documentId(postId: string): string {
  return `x_${createHash("sha256").update(postId).digest("hex").slice(0, 24)}`;
}

function accountFrom(href: string | null, accountText?: string): ProviderAuthAccount | undefined {
  let handle: string | undefined;
  if (href) {
    try {
      const parsed = new URL(href, X_ORIGIN);
      const first = parsed.pathname.split("/").filter(Boolean)[0];
      if (
        first &&
        !["home", "explore", "search", "settings", "messages", "notifications", "compose", "i"].includes(first)
      ) {
        handle = `@${first}`;
      }
    } catch {
      // 继续尝试从页面文本识别账号。
    }
  }

  const lines = String(accountText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const textHandle = lines.find((line) => /^@[A-Za-z0-9_]{1,15}$/.test(line));
  if (!handle && textHandle) handle = textHandle;
  if (!handle) return undefined;

  const displayName = lines.find((line) => !line.startsWith("@") && line !== "Account");
  return displayName ? { handle, displayName } : { handle };
}

function isLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === "x.com" || url.hostname === "twitter.com") && LOGIN_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

async function inspectAuth(page: Page): Promise<ProviderAuthState> {
  const checkedAt = Date.now();

  if (isLoginUrl(page.url())) {
    return { status: "auth_required", checkedAt };
  }

  if (await page.locator('input[autocomplete="username"]').count().catch(() => 0)) {
    return { status: "auth_required", checkedAt };
  }

  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
  const profileHref = await profileLink.getAttribute("href").catch(() => null);
  const accountText = await page
    .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
    .first()
    .innerText({ timeout: 1_500 })
    .catch(() => "");
  const account = accountFrom(profileHref, accountText);

  if (profileHref || account) {
    return {
      status: "authenticated",
      ...(account ? { account } : {}),
      checkedAt,
    };
  }

  const authenticatedUi = page.locator(
    '[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_Home_Link"]',
  );
  if (await authenticatedUi.count().catch(() => 0)) {
    return { status: "authenticated", checkedAt };
  }

  return { status: "unknown", checkedAt };
}

async function goto(page: Page, url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
      signal,
    } as any);
  } catch (error) {
    if (signal?.aborted) {
      throw new RetrievalError("TIMEOUT", "X browser navigation was cancelled", {
        retryable: true,
        cause: error,
      });
    }
    throw new RetrievalError("NETWORK_ERROR", `X browser navigation failed: ${url}`, {
      retryable: true,
      cause: error,
    });
  }
}

function searchUrl(query: string): string {
  const url = new URL("/search", X_ORIGIN);
  url.searchParams.set("q", query);
  url.searchParams.set("src", "typed_query");
  url.searchParams.set("f", "live");
  return url.toString();
}

function normalizePost(raw: RawPost) {
  const match = raw.href.match(/^\/?([^/?#]+)\/status\/(\d+)/);
  if (!match) return undefined;

  const [, handlePart, postId] = match;
  if (!handlePart || !postId) return undefined;

  const text = raw.text.trim();
  const lines = String(raw.userNameText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const displayName = lines.find((line) => !line.startsWith("@"));

  return {
    postId,
    handle: `@${handlePart}`,
    url: `${X_ORIGIN}/${handlePart}/status/${postId}`,
    text,
    ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

async function readVisiblePosts(page: Page): Promise<RawPost[]> {
  return page.locator('article[data-testid="tweet"]').evaluateAll((articles) =>
    articles.map((article) => {
      const statusAnchor = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
        .find((anchor) => /\/status\/\d+/.test(anchor.getAttribute("href") ?? ""));
      const text = article.querySelector<HTMLElement>('[data-testid="tweetText"]')?.innerText ?? "";
      const publishedAt = article.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime;
      const userNameText = article.querySelector<HTMLElement>('[data-testid="User-Name"]')?.innerText;
      return {
        href: statusAnchor?.getAttribute("href") ?? "",
        text,
        ...(publishedAt ? { publishedAt } : {}),
        ...(userNameText ? { userNameText } : {}),
      };
    }),
  );
}

export const xSearchFactory: ProviderFactory = {
  type: "x-search",
  // X 原生查询只覆盖搜索;不实现 Extract。
  capabilities: ["search"],
  authControl: true,

  create(id, config, services) {
    if (!services.browser) {
      throw new RetrievalError("PROVIDER_UNAVAILABLE", "x-search requires a BrowserHost on this Runtime");
    }

    const browser = services.browser;
    const profileId = config.browser?.profile ?? services.defaultBrowserProfile;
    if (!profileId) {
      throw new RetrievalError(
        "PROFILE_AUTH_REQUIRED",
        "x-search requires provider.browser.profile or runner.browser.defaultProfile",
      );
    }

    const options = optionsFrom(config);
    const report = (state: ProviderAuthState) => services.reportAuthState?.(state);

    return {
      id,

      async checkAuth(context) {
        if (!context.jobId) throw new RetrievalError("INTERNAL_ERROR", "x-search requires a runtime jobId");

        return browser.withProfile(profileId, context.jobId, async ({ context: browserContext }) => {
          const page = await browserContext.newPage();
          try {
            await goto(page, X_HOME_URL, options.authTimeoutMs, context.signal);
            if (options.postLoadDelayMs > 0) await page.waitForTimeout(options.postLoadDelayMs);
            const state = await inspectAuth(page);
            report(state);
            return state;
          } finally {
            await page.close().catch(() => undefined);
          }
        });
      },

      async openLogin(context) {
        if (!context.jobId) throw new RetrievalError("INTERNAL_ERROR", "x-search requires a runtime jobId");

        if (browser.openInteractive) {
          await browser.openInteractive(profileId, context.jobId, X_LOGIN_URL);
          const state: ProviderAuthState = { status: "auth_required", checkedAt: Date.now() };
          report(state);
          return state;
        }

        // 兼容只实现 withProfile 的 BrowserHost。
        return browser.withProfile(profileId, context.jobId, async ({ context: browserContext }) => {
          const existing = browserContext.pages().find((candidate) => isLoginUrl(candidate.url()));
          const page = existing ?? await browserContext.newPage();
          await goto(page, X_LOGIN_URL, options.timeoutMs, context.signal);
          if (options.postLoadDelayMs > 0) await page.waitForTimeout(options.postLoadDelayMs);
          await page.bringToFront().catch(() => undefined);
          const state = await inspectAuth(page);
          report(state);
          return state;
        });
      },

      async search(context, request) {
        if (!context.jobId) throw new RetrievalError("INTERNAL_ERROR", "x-search requires a runtime jobId");

        const query = request.query.trim();
        if (!query) throw new RetrievalError("INVALID_REQUEST", "x-search query cannot be empty");
        const limit = Math.min(100, Math.max(1, request.limit ?? 20));

        return browser.withProfile(profileId, context.jobId, async ({ context: browserContext }) => {
          const page = await browserContext.newPage();

          try {
            await goto(page, searchUrl(query), options.timeoutMs, context.signal);
            if (options.postLoadDelayMs > 0) await page.waitForTimeout(options.postLoadDelayMs);

            const auth = await inspectAuth(page);
            report(auth);
            if (auth.status === "auth_required") {
              throw new RetrievalError(
                "PROFILE_AUTH_REQUIRED",
                "X login is required. Open Admin → Providers and use 登录/重新登录 for this Provider.",
              );
            }

            const found = new Map<string, NonNullable<ReturnType<typeof normalizePost>>>();
            for (let scroll = 0; scroll <= options.maxScrolls && found.size < limit; scroll += 1) {
              const visible = await readVisiblePosts(page);
              for (const raw of visible) {
                const post = normalizePost(raw);
                if (post) found.set(post.postId, post);
                if (found.size >= limit) break;
              }

              if (found.size >= limit || scroll === options.maxScrolls) break;
              await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700)));
              await page.waitForTimeout(options.scrollDelayMs);
            }

            if (found.size > 0 && auth.status !== "authenticated") {
              report({
                status: "authenticated",
                ...(auth.account ? { account: auth.account } : {}),
                checkedAt: Date.now(),
              });
            }

            const retrievedAt = new Date().toISOString();
            return {
              items: [...found.values()].slice(0, limit).map((post) => ({
                id: documentId(post.postId),
                platform: "x",
                type: "post",
                url: post.url,
                canonicalUrl: post.url,
                title: post.displayName ? `${post.displayName} (${post.handle})` : post.handle,
                text: post.text || undefined,
                snippet: post.text ? post.text.slice(0, 500) : undefined,
                publishedAt: post.publishedAt,
                retrievedAt,
                provenance: {
                  provider: id,
                  retrievalMethod: "browser",
                  providerItemId: post.postId,
                  requestId: context.requestId,
                  fetchedAt: retrievedAt,
                  runtimeId: context.runtimeId,
                },
                extensions: {
                  author: {
                    handle: post.handle,
                    ...(post.displayName ? { displayName: post.displayName } : {}),
                  },
                  profileId,
                  query,
                  resultMode: "latest",
                },
              })),
            };
          } finally {
            await page.close().catch(() => undefined);
          }
        });
      },
    };
  },
};

export default {
  name: "aylens-x-search",
  version: "1.0.0",
  factories: [xSearchFactory],
};
