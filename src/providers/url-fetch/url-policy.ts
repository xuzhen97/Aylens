import { RetrievalError } from "../../core/errors.js";

/**
 * 校验 url-fetch 的输入目标。
 *
 * 只允许 HTTP(S)、拒绝 URL 内嵌凭据；网络层可达性由 `resolvePublicTarget` 在连接点判定，
 * 因此这里不做 DNS 解析，也不因为"看起来像公网"就放行。
 */
export function parseTargetUrl(input: unknown): URL {
  const raw = typeof input === "string" ? input.trim() : String(input ?? "").trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new RetrievalError("URL_FORBIDDEN", "url-fetch requires a valid absolute URL", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RetrievalError(
      "URL_FORBIDDEN",
      `url-fetch only supports http/https URLs: ${url.protocol}`,
    );
  }

  if (url.username || url.password) {
    throw new RetrievalError(
      "URL_FORBIDDEN",
      "url-fetch does not allow credentials embedded in the target URL",
    );
  }

  return url;
}
