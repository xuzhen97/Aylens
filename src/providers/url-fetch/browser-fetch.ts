import type { Page } from "playwright-core";

import type { BrowserHost } from "../../browser/types.js";
import { RetrievalError } from "../../core/errors.js";
import type { ProviderContext } from "../types.js";
import type { UrlFetchOptions } from "./options.js";

export interface BrowserFetchResult {
  url: string;
  status: number;
  html: string;
}

/** 渲染等待的上限：不依赖 networkidle（它会一直拖满预算），只等正文出现。 */
const RENDERED_CONTENT_TIMEOUT_MS = 2_000;
const MIN_RENDERED_TEXT = 40;

/**
 * 最后一次浏览器尝试。
 *
 * 会话决策：复用 Runner 的持久化 Profile（默认 browser-main），因此可能携带已有登录态；
 * HTTP 阶段始终匿名，不读取、不导出 Chrome Cookie。
 */
export async function fetchBrowserTarget(
  browser: BrowserHost | undefined,
  profileId: string | undefined,
  context: ProviderContext,
  target: URL,
  options: UrlFetchOptions,
  signal: AbortSignal,
): Promise<BrowserFetchResult> {
  // 出口未确认时明确拒绝。这个开关只是"部署环境已有受控出口"的声明，
  // 不是实现出来的安全保证，因此默认关闭，且不提供绕过私有地址检查的选项。
  if (!options.controlledBrowserEgress) {
    throw new RetrievalError(
      "NETWORK_POLICY_REJECTED",
      "Browser fallback requires a confirmed controlled egress; only enable controlledBrowserEgress when the Runner's browser egress is already constrained",
    );
  }

  if (!browser) {
    throw new RetrievalError("PROVIDER_UNAVAILABLE", "Browser fallback is unavailable on this Runtime");
  }

  if (!profileId) {
    throw new RetrievalError("PROFILE_AUTH_REQUIRED", "Browser fallback requires a browser profile");
  }

  if (!context.jobId) {
    throw new RetrievalError("INTERNAL_ERROR", "Browser fallback requires a runtime jobId");
  }

  throwIfAborted(signal);

  return await browser.withProfile(
    profileId,
    context.jobId,
    async ({ context: browserContext }) => {
      const page = await browserContext.newPage();
      const closePage = (): void => {
        void page.close().catch(() => undefined);
      };

      // Playwright 的 goto 不接受 AbortSignal，取消只能靠主动关闭本次页面。
      signal.addEventListener("abort", closePage, { once: true });

      try {
        throwIfAborted(signal);

        const response = await page.goto(target.toString(), {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs,
        });

        await waitForRenderedContent(page, options.timeoutMs, signal);
        throwIfAborted(signal);

        return {
          url: page.url(),
          status: response?.status() ?? 0,
          html: await page.content(),
        };
      } catch (error) {
        if (signal.aborted) throw cancelledError();
        throw error;
      } finally {
        signal.removeEventListener("abort", closePage);
        // 只关闭本次页面；共享的持久化 context 留给后续请求，不能关闭。
        await page.close().catch(() => undefined);
      }
    },
    { signal },
  );
}

async function waitForRenderedContent(page: Page, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const budget = Math.min(RENDERED_CONTENT_TIMEOUT_MS, timeoutMs);
  if (budget <= 0 || signal.aborted) return;

  try {
    await page.waitForFunction(
      (minLength: number) => (document.body?.innerText ?? "").trim().length >= minLength,
      MIN_RENDERED_TEXT,
      { timeout: budget },
    );
  } catch {
    // 等到超时不等于失败：页面本来就可能很短，最终判定交给共享分类逻辑。
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}

function cancelledError(): RetrievalError {
  return new RetrievalError("TIMEOUT", "Browser navigation was cancelled", { retryable: true });
}
