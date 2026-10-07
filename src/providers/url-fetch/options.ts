import { RetrievalError } from "../../core/errors.js";

export interface UrlFetchOptions {
  timeoutMs: number;
  httpTimeoutMs: number;
  maxResponseBytes: number;
  maxDecodedBytes: number;
  maxDomElements: number;
  maxMarkdownChars: number;
  maxTextChars: number;
  snippetChars: number;
  contentMode: "auto" | "article" | "full";
  contentSelector?: string | undefined;
  browserFallback: boolean;
  fallbackOnHttpTimeout: boolean;
  controlledProxyEgress: boolean;
  controlledBrowserEgress: boolean;
}

/**
 * 默认值刻意低于 Gateway 的任务期限，给返回与清理留出余量；
 * 总预算由 Provider 统一分配，各阶段不再各自重新计时。
 */
export const DEFAULT_URL_FETCH_OPTIONS: UrlFetchOptions = {
  timeoutMs: 25_000,
  httpTimeoutMs: 8_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 5 * 1024 * 1024,
  maxDomElements: 50_000,
  maxMarkdownChars: 100_000,
  maxTextChars: 50_000,
  snippetChars: 500,
  contentMode: "auto",
  browserFallback: true,
  fallbackOnHttpTimeout: false,
  // 这两项是"部署环境已经存在受控出口"的声明，不是实现出来的安全保证；
  // 未确认时保持 false，代理与浏览器兜底会被拒绝，静态直连不受影响。
  controlledProxyEgress: false,
  controlledBrowserEgress: false,
};

const NUMBER_BOUNDS: Record<string, { min: number; max: number }> = {
  timeoutMs: { min: 1_000, max: 120_000 },
  httpTimeoutMs: { min: 500, max: 60_000 },
  maxResponseBytes: { min: 1_024, max: 50 * 1024 * 1024 },
  maxDecodedBytes: { min: 1_024, max: 100 * 1024 * 1024 },
  maxDomElements: { min: 100, max: 500_000 },
  maxMarkdownChars: { min: 1_000, max: 1_000_000 },
  maxTextChars: { min: 1_000, max: 1_000_000 },
  snippetChars: { min: 100, max: 5_000 },
};

const BOOLEAN_KEYS = [
  "browserFallback",
  "fallbackOnHttpTimeout",
  "controlledProxyEgress",
  "controlledBrowserEgress",
] as const;

const CONTENT_MODES = new Set(["auto", "article", "full"]);

const KNOWN_KEYS = new Set<string>([
  ...Object.keys(NUMBER_BOUNDS),
  ...BOOLEAN_KEYS,
  "contentMode",
  "contentSelector",
]);

/**
 * 严格解析 Provider 部署选项：类型错误、越界与未知键都明确失败。
 *
 * 旧版 generic-browser 会静默回退到默认值，导致配置文件里拼错的选项长期无效；
 * 这里选择报错，让配置问题在启用时暴露，而不是悄悄变成"行为和配置不一致"。
 */
export function parseOptions(raw: Record<string, unknown>): UrlFetchOptions {
  const options: UrlFetchOptions = { ...DEFAULT_URL_FETCH_OPTIONS };

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw invalidOption(`Unknown url-fetch option: ${key}`);
    }
  }

  for (const [key, bounds] of Object.entries(NUMBER_BOUNDS)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidOption(`url-fetch option ${key} must be a finite number`);
    }
    if (value < bounds.min || value > bounds.max) {
      throw invalidOption(`url-fetch option ${key} must be between ${bounds.min} and ${bounds.max}`);
    }
    Object.assign(options, { [key]: Math.trunc(value) });
  }

  for (const key of BOOLEAN_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw invalidOption(`url-fetch option ${key} must be a boolean`);
    Object.assign(options, { [key]: value });
  }

  const contentMode = raw.contentMode;
  if (contentMode !== undefined) {
    if (typeof contentMode !== "string" || !CONTENT_MODES.has(contentMode)) {
      throw invalidOption("url-fetch option contentMode must be one of: auto, article, full");
    }
    options.contentMode = contentMode as UrlFetchOptions["contentMode"];
  }

  const contentSelector = raw.contentSelector;
  if (contentSelector !== undefined) {
    if (typeof contentSelector !== "string" || contentSelector.trim() === "") {
      throw invalidOption("url-fetch option contentSelector must be a non-empty string");
    }
    options.contentSelector = contentSelector.trim();
  }

  return options;
}

function invalidOption(message: string): RetrievalError {
  return new RetrievalError("INVALID_REQUEST", message);
}
