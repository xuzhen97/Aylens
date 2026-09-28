import type { ProviderDeploymentConfig } from "../../config/schema.js";
import type { ProviderFactory } from "../types.js";

import { createHash } from "node:crypto";

const WAIT_UNTIL = new Set(["load", "domcontentloaded", "networkidle"]);

function structuredError(code: string, message: string, retryable = false, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string; retryable: boolean };
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseTargetUrl(value: unknown): string {
  let url;

  try {
    url = new URL(String(value).trim());
  } catch (error) {
    throw structuredError("URL_FORBIDDEN", "generic-browser query must be a valid URL", false, error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw structuredError(
      "URL_FORBIDDEN",
      `generic-browser only supports http/https URLs: ${url.protocol}`,
    );
  }

  if (url.username || url.password) {
    throw structuredError(
      "URL_FORBIDDEN",
      "generic-browser does not allow credentials embedded in the target URL",
    );
  }

  return url.toString();
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function optionsFrom(config: ProviderDeploymentConfig) {
  const options = config.options ?? {};
  const waitUntil = typeof options.waitUntil === "string" && WAIT_UNTIL.has(options.waitUntil)
    ? options.waitUntil as "load" | "domcontentloaded" | "networkidle"
    : "domcontentloaded";

  return {
    waitUntil,
    timeoutMs: boundedNumber(options.timeoutMs, 30_000, 1_000, 120_000),
    extractionTimeoutMs: boundedNumber(
      options.extractionTimeoutMs,
      10_000,
      500,
      60_000,
    ),
    postLoadDelayMs: boundedNumber(options.postLoadDelayMs, 0, 0, 120_000),
    maxTextChars: boundedNumber(options.maxTextChars, 50_000, 1_000, 500_000),
    snippetChars: boundedNumber(options.snippetChars, 500, 100, 5_000),
    textSelector:
      typeof options.textSelector === "string" && options.textSelector.trim()
        ? options.textSelector.trim()
        : "body",
    keepPageOpen: options.keepPageOpen === true,
  };
}

function documentId(url: string): string {
  return `doc_${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

function cancelledError() {
  return structuredError(
    "TIMEOUT",
    "Browser navigation was cancelled before it completed",
    true,
  );
}

export const genericBrowserFactory: ProviderFactory = {
  type: "generic-browser",

  create(id, config, services) {
    if (!services.browser) {
      throw structuredError(
        "PROVIDER_UNAVAILABLE",
        "generic-browser requires a BrowserHost on this Runtime",
      );
    }

    const browser = services.browser;
    const profileId = config.browser?.profile;
    if (!profileId) {
      throw structuredError(
        "PROFILE_AUTH_REQUIRED",
        "generic-browser requires provider.browser.profile",
      );
    }

    const options = optionsFrom(config);

    return {
      id,

      async search(context, request) {
        if (!context.jobId) {
          throw structuredError(
            "INTERNAL_ERROR",
            "generic-browser requires a runtime jobId",
          );
        }

        const requestedUrl = parseTargetUrl(request.query);
        // Set when the Gateway gives up on this job, or the Runner is shutting
        // down. Without it a cancelled job kept a browser profile leased until
        // its own navigation timeout expired.
        const { signal } = context;

        return browser.withProfile(
          profileId,
          context.jobId,
          async ({ context: browserContext }) => {
            const page = await browserContext.newPage();
            const closePage = !options.keepPageOpen;

            try {
              let response;

              try {
                response = await page.goto(requestedUrl, {
                  waitUntil: options.waitUntil,
                  timeout: options.timeoutMs,
                  signal,
                } as any);
              } catch (error) {
                if (signal?.aborted) throw cancelledError();
                throw structuredError(
                  "NETWORK_ERROR",
                  `Browser navigation failed: ${requestedUrl}`,
                  true,
                  error,
                );
              }

              if (signal?.aborted) throw cancelledError();

              if (options.postLoadDelayMs > 0) {
                await page.waitForTimeout(options.postLoadDelayMs);
              }

              let title;
              let rawText;

              try {
                [title, rawText] = await Promise.all([
                  page.title(),
                  page
                    .locator(options.textSelector)
                    .first()
                    .innerText({ timeout: options.extractionTimeoutMs }),
                ]);
              } catch (error) {
                if (signal?.aborted) throw cancelledError();
                throw structuredError(
                  "CONTENT_UNAVAILABLE",
                  `Unable to extract page content with selector: ${options.textSelector}`,
                  false,
                  error,
                );
              }

              const normalized = normalizeText(rawText);
              if (!normalized) {
                throw structuredError(
                  "CONTENT_UNAVAILABLE",
                  "Browser page contained no readable text",
                );
              }

              const finalUrl = page.url();
              const truncated = normalized.length > options.maxTextChars;
              const text = truncated
                ? normalized.slice(0, options.maxTextChars)
                : normalized;
              const snippet = text.slice(0, options.snippetChars);
              const retrievedAt = new Date().toISOString();

              return {
                items: [
                  {
                    id: documentId(finalUrl),
                    platform: "web",
                    type: "webpage",
                    url: finalUrl,
                    canonicalUrl: finalUrl,
                    title: normalizeText(title) || undefined,
                    text,
                    snippet,
                    retrievedAt,
                    provenance: {
                      provider: id,
                      retrievalMethod: "browser",
                      requestId: context.requestId,
                      fetchedAt: retrievedAt,
                      runtimeId: context.runtimeId,
                    },
                    extensions: {
                      requestedUrl,
                      profileId,
                      httpStatus: response?.status?.() ?? null,
                      textSelector: options.textSelector,
                      contentChars: normalized.length,
                      truncated,
                      keepPageOpen: options.keepPageOpen,
                    },
                  },
                ],
              };
            } finally {
              if (closePage) {
                await page.close().catch(() => undefined);
              }
            }
          },
        );
      },
    };
  },
};

export default {
  name: "aylens-generic-browser",
  version: "1.0.0",
  factories: [genericBrowserFactory],
};
