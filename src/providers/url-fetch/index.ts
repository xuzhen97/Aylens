import { createHash } from "node:crypto";

import type { ProviderDeploymentConfig } from "../../config/schema.js";
import type { ProviderSearchResponse, SearchDocument } from "../../contracts/search.js";
import { RetrievalError } from "../../core/errors.js";
import type { HttpTransport, TransportResponsePolicy } from "../../transports/types.js";
import type { ProviderFactory, ProviderFactoryContext, ProviderContext } from "../types.js";
import type { Budget } from "./budget.js";
import { createBudget } from "./budget.js";
import { fetchBrowserTarget, type BrowserFetchResult } from "./browser-fetch.js";
import type { ContentFormat, FallbackReason } from "./content.js";
import { classifyContent } from "./content.js";
import { extractContent } from "./extract.js";
import type { HttpFetchResult } from "./http-fetch.js";
import { fetchHttpTarget } from "./http-fetch.js";
import type { UrlFetchOptions } from "./options.js";
import { parseOptions } from "./options.js";
import { parseTargetUrl } from "./url-policy.js";

/** 只有这两种底层网络错误才值得换下一个传输；安全/解析/资源拒绝一律不回退。 */
const RETRYABLE_TRANSPORT_CODES = new Set(["NETWORK_ERROR", "PROXY_FAILED"]);

const DEFAULT_TRANSPORT_ID = "direct";
const DOCUMENT_ID_CHARS = 24;

/** 浏览器兜底"此刻跑不起来"的几种情况；这些情况下若已有可读内容，不应让整个请求失败。 */
const UNAVAILABLE_FALLBACK_CODES = new Set([
  "NETWORK_POLICY_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "PROFILE_AUTH_REQUIRED",
  "PROFILE_BUSY",
]);

/** js-shell 是启发式，只有静态文本达到这个量级才敢用它代替渲染结果。 */
const MIN_SALVAGE_TEXT = 40;

export const urlFetchFactory: ProviderFactory = {
  type: "url-fetch",
  // 只实现搜索(输入 URL → 文档);指定 URL 的独立提取走 Extract 能力,此处未实现。
  capabilities: ["search"],

  create(id, config, services) {
    // 创建时只解析选项，不要求 BrowserHost：没有浏览器的 Runner 仍能完成静态获取。
    const options = parseOptions(config.options ?? {});
    const profileId = config.browser?.profile ?? services.defaultBrowserProfile;
    const transportIds = resolveTransportIds(config);

    return {
      id,

      async search(context, request) {
        if (!context.jobId) {
          throw new RetrievalError("INTERNAL_ERROR", "url-fetch requires a runtime jobId");
        }

        const target = parseTargetUrl(request.query);
        const budget = createBudget(context.signal, options.timeoutMs);

        try {
          return await runFetch({ id, options, profileId, transportIds, services, context, target, budget, requested: target.toString() });
        } finally {
          budget.dispose();
        }
      },
    };
  },
};

interface FetchParams {
  id: string;
  options: UrlFetchOptions;
  profileId: string | undefined;
  transportIds: string[];
  services: ProviderFactoryContext;
  context: ProviderContext;
  target: URL;
  budget: Budget;
  requested: string;
}

async function runFetch(params: FetchParams): Promise<ProviderSearchResponse> {
  let httpResult: HttpFetchResult | undefined;

  try {
    httpResult = await runHttpTarget(params);
  } catch (error) {
    if (!(error instanceof RetrievalError)) throw error;

    // HTTP 超时只有配置允许且预算还有余量时才升级为浏览器尝试。
    if (error.code === "TIMEOUT" && params.options.fallbackOnHttpTimeout && params.budget.remainingMs() > 0) {
      return await browserPath(params, "http-timeout");
    }

    throw error;
  }

  const decision = classifyContent(
    httpResult.status,
    httpResult.headers.get("content-type"),
    httpResult.body,
  );

  if (decision.kind === "reject") throw rejectedError(decision.code);
  if (decision.kind === "browser") {
    // 把已安全获取的静态结果传入：兜底不可用时它是唯一可用的退路。
    return await browserPath(params, decision.reason, { result: httpResult, format: "html" });
  }

  const extracted = extractContent(httpResult.body, httpResult.url, decision.format, params.options);

  return buildResponse(params, {
    engine: "http",
    format: decision.format,
    finalUrl: httpResult.url,
    status: httpResult.status,
    extracted,
    warnings: httpResult.decodeWarning === undefined ? [] : [httpResult.decodeWarning],
  });
}

async function runHttpTarget(params: FetchParams): Promise<HttpFetchResult> {
  let lastError: RetrievalError | undefined;

  for (const transportId of params.transportIds) {
    const direct = params.services.transports.getConfig(transportId)?.type === "direct";

    // 代理出口未确认时明确拒绝：不静默跳过，也不假装本地 DNS 校验等同于远端出口安全。
    if (!direct && !params.options.controlledProxyEgress) {
      throw new RetrievalError(
        "NETWORK_POLICY_REJECTED",
        `Transport ${transportId} is a proxy; enable controlledProxyEgress only when the Runner's egress is already constrained`,
      );
    }

    const transport: HttpTransport = params.services.transports.get(transportId);
    const httpBudget = createBudget(
      params.budget.signal,
      Math.min(params.options.httpTimeoutMs, params.budget.remainingMs()),
    );

    try {
      return await fetchHttpTarget(
        params.target,
        transport,
        responsePolicy(params.options, direct ? "public" : "controlled-egress"),
        httpBudget.signal,
      );
    } catch (error) {
      if (!(error instanceof RetrievalError)) throw error;
      if (!error.retryable || !RETRYABLE_TRANSPORT_CODES.has(error.code)) throw error;
      lastError = error;
    } finally {
      httpBudget.dispose();
    }
  }

  throw lastError ?? new RetrievalError("NETWORK_ERROR", "No usable transport for url-fetch", { retryable: true });
}

interface HttpFallback {
  result: HttpFetchResult;
  format: ContentFormat;
}

async function browserPath(
  params: FetchParams,
  reason: FallbackReason,
  fallback?: HttpFallback,
): Promise<ProviderSearchResponse> {
  if (!params.options.browserFallback) {
    return salvageOrFail(params, fallback, reason, "browser fallback is disabled");
  }

  let result: BrowserFetchResult;

  try {
    result = await fetchBrowserTarget(
      params.services.browser,
      params.profileId,
      params.context,
      params.target,
      params.options,
      params.budget.signal,
    );
  } catch (error) {
    if (error instanceof RetrievalError && UNAVAILABLE_FALLBACK_CODES.has(error.code)) {
      return salvageOrFail(params, fallback, reason, `browser fallback is unavailable (${error.code})`);
    }
    throw error;
  }

  const decision = classifyContent(result.status, "text/html", result.html);

  if (decision.kind === "reject") throw rejectedError(decision.code);
  // 兜底之后仍然停在登录页或挑战页时必须明确失败，不能当成成功正文返回。
  if (decision.kind === "browser") throw unresolvedFallbackError(decision.reason);

  const extracted = extractContent(result.html, result.url, decision.format, params.options);

  return buildResponse(params, {
    engine: "browser",
    format: decision.format,
    finalUrl: result.url,
    status: result.status,
    extracted,
    warnings: [`browser fallback: ${reason}`],
  });
}

interface BuildInput {
  engine: "http" | "browser";
  format: ContentFormat;
  finalUrl: string;
  status: number;
  extracted: ReturnType<typeof extractContent>;
  warnings: string[];
}

function buildResponse(params: FetchParams, input: BuildInput): ProviderSearchResponse {
  const retrievedAt = new Date().toISOString();
  const { extracted } = input;

  const document: SearchDocument = {
    id: `doc_${createHash("sha256").update(input.finalUrl).digest("hex").slice(0, DOCUMENT_ID_CHARS)}`,
    platform: "web",
    type: "webpage",
    url: input.finalUrl,
    // 没有有效 canonical 时回退到最终地址，且不为它额外发请求。
    canonicalUrl: extracted.canonicalUrl ?? input.finalUrl,
    title: extracted.title,
    text: extracted.text,
    markdown: extracted.markdown,
    snippet: extracted.text.slice(0, params.options.snippetChars),
    retrievedAt,
    provenance: {
      provider: params.id,
      retrievalMethod: input.engine === "browser" ? "browser" : "http",
      requestId: params.context.requestId,
      fetchedAt: retrievedAt,
      runtimeId: params.context.runtimeId,
    },
    extensions: {
      requestedUrl: params.requested,
      engine: input.engine,
      format: input.format,
      extractionMethod: extracted.extractionMethod,
      httpStatus: input.status,
      markdownChars: extracted.markdown.length,
      textChars: extracted.text.length,
      truncated: extracted.truncated,
      warnings: [...extracted.warnings, ...input.warnings],
    },
  };

  return { items: [document] };
}

function responsePolicy(
  options: UrlFetchOptions,
  network: "public" | "controlled-egress",
): TransportResponsePolicy {
  return {
    maxBytes: options.maxResponseBytes,
    maxDecodedBytes: options.maxDecodedBytes,
    decode: "web",
    redirect: "manual",
    network,
  };
}

function resolveTransportIds(config: ProviderDeploymentConfig): string[] {
  const configured = config.transport;
  if (!configured) return [DEFAULT_TRANSPORT_ID];
  return [configured.primary, ...(configured.fallback ?? [])];
}

function rejectedError(code: RetrievalError["code"]): RetrievalError {
  // 不回显完整 URL，避免把查询参数里的敏感信息带进错误文本。
  return new RetrievalError(code, "url-fetch could not retrieve readable content");
}

/**
 * 兜底跑不起来时的取舍。
 *
 * js-shell 只是启发式（正文很短但带 script 的正常短页也会命中），所以当静态内容确实
 * 可读时直接返回它——比让整个请求失败有用，也不需要任何额外的网络访问。
 *
 * 登录页 / 挑战页不在此列：把登录页当成正文成功返回，才是真正的错误。
 */
function salvageOrFail(
  params: FetchParams,
  fallback: HttpFallback | undefined,
  reason: FallbackReason,
  detail: string,
): ProviderSearchResponse {
  if (reason === "js-shell" && fallback) {
    const extracted = extractContent(
      fallback.result.body,
      fallback.result.url,
      fallback.format,
      params.options,
    );

    if (extracted.text.length >= MIN_SALVAGE_TEXT) {
      return buildResponse(params, {
        engine: "http",
        format: fallback.format,
        finalUrl: fallback.result.url,
        status: fallback.result.status,
        extracted,
        warnings: [`static content returned because ${detail}`],
      });
    }
  }

  throw new RetrievalError(
    "CONTENT_UNAVAILABLE",
    `The page needs rendering or a session, and ${detail}`,
  );
}

function unresolvedFallbackError(reason: FallbackReason): RetrievalError {
  if (reason === "auth-required") {
    return new RetrievalError(
      "UPSTREAM_AUTH_FAILED",
      "The page still requires authentication after the browser attempt",
    );
  }

  if (reason === "challenge") {
    return new RetrievalError(
      "BLOCKED",
      "The page still presents an access challenge after the browser attempt",
    );
  }

  return new RetrievalError(
    "CONTENT_UNAVAILABLE",
    "The page did not render readable content in the browser fallback",
  );
}

export default {
  name: "aylens-url-fetch",
  version: "1.0.0",
  factories: [urlFetchFactory],
};
