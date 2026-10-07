import { isIP } from "node:net";

import { RetrievalError } from "../../core/errors.js";
import { isPublicAddress } from "../../transports/network-policy.js";
import type { HttpTransport, TransportRequest } from "../../transports/types.js";
import { parseTargetUrl } from "./url-policy.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 机会性内容协商：站点支持时直接拿到 Markdown，不支持时如实返回 HTML。
 * 这只是 Accept 偏好，不额外发探测请求，也不假设一定生效。
 */
const FETCH_ACCEPT_HEADER = "text/markdown, text/html;q=0.9, text/plain;q=0.8";

/**
 * 必须显式带 User-Agent。
 *
 * 不带 UA 时 node:http 根本不发这个头，而不少站点（Wikimedia 等）对无 UA 请求
 * 直接返回 403；403 又会被判为"需要登录"，进而走浏览器兜底，最终在未声明
 * 浏览器出口时整体失败——真实站点因此完全抓不到。
 *
 * 如实标识自己，不伪装浏览器：伪造 UA 只会让站点把我们当浏览器而给出更差的结果。
 */
const FETCH_USER_AGENT = "Aylens-url-fetch/1.0 (+https://github.com/xuzhen97/Aylens)";

export interface HttpFetchResult {
  url: string;
  status: number;
  headers: Headers;
  body: string;
  /** 降级解码原因（声明编码与实际字节不符），必须向上传递而不是默默丢弃。 */
  decodeWarning?: string | undefined;
}

/**
 * 手动执行重定向循环：每一跳都走同一套目标校验与传输策略。
 *
 * 传输层禁止自动跟随重定向（responsePolicy.redirect = "manual"），否则校验过的起始地址
 * 可以通过 302 把请求带到未校验的目标上。
 */
export async function fetchHttpTarget(
  target: URL,
  transport: HttpTransport,
  policy: NonNullable<TransportRequest["responsePolicy"]>,
  signal: AbortSignal,
): Promise<HttpFetchResult> {
  let current = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await transport.request({
      url: current.toString(),
      method: "GET",
      // 匿名获取：只声明期望的内容类型与自身身份，不携带 Cookie / Authorization。
      headers: { accept: FETCH_ACCEPT_HEADER, "user-agent": FETCH_USER_AGENT },
      responsePolicy: policy,
      signal,
    });

    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) {
      return {
        url: response.finalUrl ?? current.toString(),
        status: response.status,
        headers: response.headers,
        body: response.body,
        decodeWarning: response.decodeWarning,
      };
    }

    if (hop === MAX_REDIRECTS) {
      throw new RetrievalError(
        "UPSTREAM_ERROR",
        `Target exceeded ${MAX_REDIRECTS} redirects`,
      );
    }

    current = redirectTarget(location, current);
  }

  throw new RetrievalError("UPSTREAM_ERROR", "Redirect loop could not be resolved");
}

/** 重定向目标按与初始目标相同的规则校验：协议、内嵌凭据，以及明显的非公网字面地址。 */
function redirectTarget(location: string, base: URL): URL {
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch (error) {
    throw new RetrievalError("UPSTREAM_ERROR", "Redirect target is not a valid URL", { cause: error });
  }

  const next = parseTargetUrl(resolved.toString());
  const host = next.hostname.replace(/^\[|\]$/g, "");

  // 字面地址无需 DNS 即可判定，先在这里挡掉；域名形式的私网目标由连接点校验拦截。
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new RetrievalError("URL_FORBIDDEN", "Redirect target is not a public address");
  }

  return next;
}
