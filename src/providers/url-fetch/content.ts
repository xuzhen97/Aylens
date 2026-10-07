import type { RetrievalErrorCode } from "../../core/errors.js";

export interface ExtractedContent {
  markdown: string;
  text: string;
  title?: string | undefined;
  canonicalUrl?: string | undefined;
  extractionMethod: string;
  truncated: boolean;
  warnings: string[];
}

export type FallbackReason = "js-shell" | "js-required" | "auth-required" | "challenge" | "http-timeout";

export type ContentFormat = "html" | "markdown" | "text";

export type ContentDecision =
  | { kind: "usable"; format: ContentFormat }
  | { kind: "browser"; reason: FallbackReason }
  | { kind: "reject"; code: RetrievalErrorCode };

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "application/markdown"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const UNSUPPORTED_TYPES = [
  /^application\/pdf$/,
  /^image\//,
  /^audio\//,
  /^video\//,
  /^font\//,
  /^application\/(?:zip|gzip|x-tar|octet-stream|x-7z-compressed|x-rar-compressed)$/,
];

const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const SCRIPT_TAG = /<script\b/i;
const PASSWORD_INPUT = /<input[^>]+type=["']password["']/i;
const EMPTY_APP_ROOT = /<div[^>]+id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i;
const INTERACTIVE = /<(?:form|input|iframe|button)\b/i;

const JS_REQUIRED_TEXT = /(?:enable|requires?|turn on|activate)\s+javascript|请(?:启用|开启)\s*(?:浏览器)?\s*javascript/i;
const LOGIN_TEXT = /sign in to continue|log ?in to continue|please (?:sign|log) in|请先登录|登录后(?:查看|可见)/i;
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify (?:you are|that you are) human|one more step/i;
const CHALLENGE_MARKER = /(?:cf-chl-|challenge-platform|turnstile|hcaptcha|recaptcha|captcha-form|g-recaptcha)/i;

/** 极短且仍带脚本的页面按"可能是 JS 空壳"处理；阈值刻意压低，避免把正常短页误判。 */
const SHELL_TEXT_THRESHOLD = 120;

export function classifyContent(status: number, contentType: string | null, body: string): ContentDecision {
  const byStatus = classifyStatus(status);
  if (byStatus) return byStatus;

  const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

  if (MARKDOWN_TYPES.has(mime)) return { kind: "usable", format: "markdown" };
  if (HTML_TYPES.has(mime)) return classifyHtml(body);
  if (mime === "") return { kind: "usable", format: sniffFormat(body) };
  if (UNSUPPORTED_TYPES.some((pattern) => pattern.test(mime))) {
    return { kind: "reject", code: "CONTENT_UNAVAILABLE" };
  }
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") {
    return { kind: "usable", format: "text" };
  }

  // MIME 缺失或不可信时不影响安全与资源限制，但也不冒充可读内容。
  return { kind: "reject", code: "CONTENT_UNAVAILABLE" };
}

function classifyStatus(status: number): ContentDecision | undefined {
  if (status === 401 || status === 403) return { kind: "browser", reason: "auth-required" };
  if (status === 404 || status === 410) return { kind: "reject", code: "CONTENT_UNAVAILABLE" };
  if (status === 429) return { kind: "reject", code: "RATE_LIMITED" };
  if (status >= 500) return { kind: "reject", code: "UPSTREAM_ERROR" };
  if (status >= 400) return { kind: "reject", code: "UPSTREAM_ERROR" };
  // 未消化的 3xx：重定向已由调用层处理，这里剩余的都是异常。
  if (status >= 300) return { kind: "reject", code: "UPSTREAM_ERROR" };
  if (status < 200) return { kind: "reject", code: "UPSTREAM_ERROR" };
  return undefined;
}

function classifyHtml(body: string): ContentDecision {
  if (isChallengePage(body)) return { kind: "browser", reason: "challenge" };
  if (isLoginPage(body)) return { kind: "browser", reason: "auth-required" };
  if (requiresJavaScript(body) || isScriptShell(body)) {
    return { kind: "browser", reason: requiresJavaScript(body) ? "js-required" : "js-shell" };
  }
  return { kind: "usable", format: "html" };
}

function isChallengePage(body: string): boolean {
  if (CHALLENGE_TITLE.test(titleOf(body))) return true;

  // 单一关键词不足以判定：正文里讨论"验证码"、或带示例表单的文档不应被当成挑战页。
  return CHALLENGE_MARKER.test(body) &&
    INTERACTIVE.test(body) &&
    visibleText(body).length < 500;
}

function isLoginPage(body: string): boolean {
  if (!PASSWORD_INPUT.test(body)) return false;
  const text = visibleText(body);
  return LOGIN_TEXT.test(text) || text.length < 400;
}

function requiresJavaScript(body: string): boolean {
  if (JS_REQUIRED_TEXT.test(visibleText(body))) return true;
  const noscript = [...body.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)]
    .map((match) => match[1] ?? "")
    .join(" ");
  return JS_REQUIRED_TEXT.test(noscript);
}

function isScriptShell(body: string): boolean {
  if (!SCRIPT_TAG.test(body)) return false;
  return EMPTY_APP_ROOT.test(body) || visibleText(body).length < SHELL_TEXT_THRESHOLD;
}

function sniffFormat(body: string): ContentFormat {
  return /<(!doctype\s+html|html|head|body)\b/i.test(body) ? "html" : "text";
}

function titleOf(body: string): string {
  return TITLE.exec(body)?.[1] ?? "";
}

function visibleText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
