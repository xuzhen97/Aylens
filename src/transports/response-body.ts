import type { IncomingMessage } from "node:http";
import type { Readable, Transform } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
} from "node:zlib";

import { RetrievalError } from "../core/errors.js";
import type { TransportRequest } from "./types.js";

export type WebResponsePolicy = NonNullable<TransportRequest["responsePolicy"]>;

export interface WebBody {
  bytes: Uint8Array;
  body: string;
  decodeWarning?: string | undefined;
}

const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml)/i;

/** 取消必须保留为可识别的 TIMEOUT，不能被降级成普通网络错误或被代理包装成 PROXY_FAILED。 */
export function responseReadAbortedError(): RetrievalError {
  return new RetrievalError("TIMEOUT", "Response read was cancelled", { retryable: true });
}

/**
 * 受限响应读取：在下载阶段施加字节上限、处理内容编码，并按网页规则解码文本。
 *
 * 关键点是限制发生在**流读取过程中**——把整个响应读成字符串再截断，等于没有限制。
 */
export async function readWebBody(
  response: IncomingMessage,
  policy: WebResponsePolicy,
  signal?: AbortSignal | undefined,
): Promise<WebBody> {
  const raw = await readStreamBytes(response, policy.maxBytes, signal, "response");
  const decoded = await decodeContentEncoding(
    raw,
    response.headers["content-encoding"],
    policy.maxDecodedBytes,
    signal,
  );
  const { body, decodeWarning } = decodeWebText(decoded, response.headers["content-type"] ?? null);

  return { bytes: decoded, body, decodeWarning };
}

async function readStreamBytes(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(error);
    };

    function onData(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        // 超限立刻断开下载，不依赖 Content-Length，也不等内容读完。
        fail(new RetrievalError(
          "CONTENT_UNAVAILABLE",
          `${label} exceeded ${maxBytes} bytes`,
          { details: { maxBytes } },
        ));
        return;
      }
      chunks.push(buffer);
    }

    function onEnd(): void {
      succeed();
    }

    function onError(error: Error): void {
      fail(error);
    }

    function onAbort(): void {
      fail(responseReadAbortedError());
    }

    if (signal?.aborted) {
      fail(responseReadAbortedError());
      return;
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function decodeContentEncoding(
  raw: Uint8Array,
  header: string | string[] | undefined,
  maxDecodedBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const encoding = normalizeEncoding(header);
  if (encoding === "" || encoding === "identity") return raw;

  // deflate 在实际站点上有 zlib 与 raw 两种写法，先按标准解，失败再按 raw 重试。
  if (encoding === "deflate") {
    try {
      return await runDecompressor(() => createInflate(), raw, maxDecodedBytes, signal, encoding);
    } catch (error) {
      if (isLimitOrAbort(error)) throw error;
      return await runDecompressor(() => createInflateRaw(), raw, maxDecodedBytes, signal, encoding);
    }
  }

  let factory: (() => Transform) | undefined;
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      factory = () => createGunzip();
      break;
    case "br":
      factory = () => createBrotliDecompress();
      break;
    default:
      factory = undefined;
  }

  if (!factory) {
    throw new RetrievalError("PARSE_ERROR", `Unsupported content-encoding: ${encoding}`);
  }

  return await runDecompressor(factory, raw, maxDecodedBytes, signal, encoding);
}

async function runDecompressor(
  factory: () => Transform,
  raw: Uint8Array,
  maxDecodedBytes: number,
  signal: AbortSignal | undefined,
  encoding: string,
): Promise<Uint8Array> {
  const decompressor = factory();
  // 先挂监听再写数据，避免小体积响应在监听就绪前结束。
  const pending = readStreamBytes(decompressor, maxDecodedBytes, signal, `decompressed response (${encoding})`);
  decompressor.end(Buffer.from(raw));

  try {
    return await pending;
  } catch (error) {
    if (isLimitOrAbort(error)) throw error;
    throw new RetrievalError("PARSE_ERROR", `Failed to decompress ${encoding} response`, { cause: error });
  }
}

function isLimitOrAbort(error: unknown): boolean {
  return error instanceof RetrievalError &&
    (error.code === "CONTENT_UNAVAILABLE" || error.code === "TIMEOUT");
}

function normalizeEncoding(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return String(value ?? "").trim().toLowerCase();
}

function decodeWebText(
  bytes: Uint8Array,
  contentType: string | null,
): { body: string; decodeWarning?: string | undefined } {
  // 顺序：BOM → HTTP charset → HTML meta 声明 → UTF-8 默认值。
  const label = charsetFromBom(bytes) ??
    charsetFromContentType(contentType) ??
    charsetFromMeta(bytes, contentType) ??
    "utf-8";
  const normalized = normalizeCharsetLabel(label);

  let strict: TextDecoder;
  try {
    strict = new TextDecoder(normalized, { fatal: true });
  } catch (error) {
    throw new RetrievalError("PARSE_ERROR", `Unsupported response charset: ${normalized}`, { cause: error });
  }

  try {
    return { body: strict.decode(bytes) };
  } catch {
    // 严格解码失败时不静默：改用替换字符并在结果里明确记录降级原因。
    const lenient = new TextDecoder(normalized, { fatal: false }).decode(bytes);
    return {
      body: lenient,
      decodeWarning: `Response declared ${normalized} but contained invalid sequences; decoded with replacement characters`,
    };
  }
}

function charsetFromBom(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

function charsetFromContentType(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
}

function charsetFromMeta(bytes: Uint8Array, contentType: string | null): string | undefined {
  if (contentType && !HTML_CONTENT_TYPE.test(contentType)) return undefined;
  // meta 声明只可能在文档前部；按 latin1 扫描不会因编码未知而抛错。
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  return /<meta[^>]*charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head)?.[1];
}

function normalizeCharsetLabel(label: string): string {
  return label.trim().replace(/^["']|["']$/g, "").toLowerCase();
}
