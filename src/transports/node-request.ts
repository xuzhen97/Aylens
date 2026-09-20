import http, { type Agent as HttpAgent } from "node:http";
import https from "node:https";
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
  agent: HttpAgent,
): Promise<TransportResponse> {
  const url = new URL(request.url);
  const client = url.protocol === "https:" ? https : http;

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  return new Promise<TransportResponse>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: request.method ?? "GET",
        headers: request.headers,
        agent,
        signal: request.signal,
      },
      (response) => {
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

    req.on("error", reject);

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
