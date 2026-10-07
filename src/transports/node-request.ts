import http, { type Agent as HttpAgent } from "node:http";
import https from "node:https";
import { RetrievalError } from "../core/errors.js";
import { connectionOptions, resolvePublicTarget } from "./network-policy.js";
import { readWebBody, responseReadAbortedError } from "./response-body.js";
import type { TransportRequest, TransportResponse } from "./types.js";

function toHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
      continue;
    }
    result.set(name, value);
  }

  return result;
}

export async function nodeRequest(
  request: TransportRequest,
  agent?: HttpAgent | undefined,
): Promise<TransportResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    // 不回显完整 URL，避免把查询参数里的敏感信息带进错误文本。
    throw new RetrievalError("URL_FORBIDDEN", "Transport request URL is invalid", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  const policy = request.responsePolicy;

  // 公网策略要求在连接点完成校验与绑定：已验证的地址就是实际连接的地址，避免
  // 「先校验域名、再由客户端重新解析」之间的 DNS rebinding 空隙；
  // 请求目标仍是原域名，因此 Host / SNI 与证书校验照旧生效。
  const pin = policy?.network === "public"
    ? await resolvePublicTarget(url, request.signal)
    : undefined;

  const client = url.protocol === "https:" ? https : http;

  return new Promise<TransportResponse>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: request.method ?? "GET",
        headers: request.headers,
        agent,
        signal: request.signal,
        ...connectionOptions(pin),
      },
      (response) => {
        if (policy) {
          // 受限路径：限流、解压与解码都在读取阶段完成，且绝不自动跟随重定向。
          readWebBody(response, policy, request.signal).then(
            (result) => {
              resolve({
                status: response.statusCode ?? 0,
                headers: toHeaders(response.headers),
                body: result.body,
                bodyBytes: result.bytes,
                finalUrl: request.url,
                decodeWarning: result.decodeWarning,
              });
            },
            (error: unknown) => {
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
          return;
        }

        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: toHeaders(response.headers),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", (error) => {
      // 取消要保留为可识别的 TIMEOUT，不能被降级成普通网络错误。
      reject(request.signal?.aborted ? responseReadAbortedError() : error);
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
