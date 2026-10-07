import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { RetrievalError } from "../core/errors.js";

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

/**
 * 视为非公网、默认拒绝的目标段。
 *
 * 采用「允许公网以外的都不允许」的默认拒绝思路，但用显式清单表达，避免手写字符串前缀
 * 判断（`hostname.startsWith("10.")` 之类）被各种写法绕过。
 */
const BLOCKED_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const BLOCKED_IPV6 = [
  "64:ff9b:1::/48",
  "100::/64",
  "2001:2::/48",
  "2001:db8::/32",
  "2001:10::/28",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

/** 只接受公网地址；非法输入一律视为不安全，避免「解析失败就当公网」的默认放行。 */
export function isPublicAddress(value: string): boolean {
  const family = isIP(value);

  if (family === 4) {
    const parsed = ipv4ToInt(value);
    if (parsed === undefined) return false;
    return !BLOCKED_IPV4.some((cidr) => matchesCidr4(parsed, cidr));
  }

  if (family === 6) {
    const bytes = ipv6Bytes(value);
    if (!bytes) return false;
    // IPv4-mapped / compatible / NAT64 / 6to4 都用 IPv6 外壳承载 IPv4，必须先剥壳再分类。
    const embedded = embeddedIpv4(bytes);
    if (embedded !== undefined) return isPublicAddress(embedded);
    return !BLOCKED_IPV6.some((cidr) => matchesCidr6(bytes, cidr));
  }

  return false;
}

/**
 * 解析并校验目标，返回可绑定的地址。
 *
 * 代理或调用方不得拿域名重新解析后再连接：那会在校验与实际连接之间留下 DNS rebinding 空隙。
 */
export async function resolvePublicTarget(
  target: URL,
  signal?: AbortSignal | undefined,
): Promise<ResolvedTarget> {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);

  if (literalFamily !== 0) {
    if (!isPublicAddress(hostname)) throw forbiddenTarget();
    return { address: hostname, family: literalFamily === 6 ? 6 : 4 };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(hostname, { all: true });
  } catch (error) {
    throw new RetrievalError("NETWORK_ERROR", "Failed to resolve target host", {
      retryable: true,
      cause: error,
    });
  }

  if (signal?.aborted) {
    throw new RetrievalError("TIMEOUT", "Target resolution was cancelled", { retryable: true });
  }

  if (answers.length === 0) {
    throw new RetrievalError("NETWORK_ERROR", "Target host did not resolve to any address", {
      retryable: true,
    });
  }

  // 评估全部答案：只要有一个落到非公网段就整体拒绝，避免挑一个"看起来安全"的地址。
  if (answers.some((answer) => !isPublicAddress(answer.address))) throw forbiddenTarget();

  const first = answers[0];
  if (!first) throw forbiddenTarget();

  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function forbiddenTarget(): RetrievalError {
  return new RetrievalError("URL_FORBIDDEN", "Target is not a public HTTP(S) address");
}

/**
 * 把连接绑定到已验证的地址，同时保留原始域名用于 Host/SNI 与证书校验。
 *
 * Node 在启用地址族竞速时会以 `{ all: true }` 调用 lookup，因此两种回调形式都要支持。
 */
export function pinnedLookup(pin: ResolvedTarget): LookupFunction {
  // SAFETY: @types/node 的 LookupFunction 只描述单一重载（通常带 `all`），
  // 而 http.request 在启用地址族竞速时会以 `{ all: true }` 调用、否则按单地址回调。
  // 下面这个函数显式处理两种形式，并有单测固定该约定；除此外不使用该地址以外的任何输入。
  return ((_hostname: string, options: unknown, callback: (error: Error | null, address?: unknown, family?: number) => void) => {
    if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) {
      callback(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    callback(null, pin.address, pin.family);
  }) as unknown as LookupFunction;
}

/** 连接选项：有 pin 时禁用地址族竞速，确保只连已验证的那个地址。 */
export function connectionOptions(pin: ResolvedTarget | undefined): {
  lookup?: LookupFunction | undefined;
  autoSelectFamily?: boolean | undefined;
} {
  if (!pin) return {};
  return { lookup: pinnedLookup(pin), autoSelectFamily: false };
}

function embeddedIpv4(bytes: Uint8Array): string | undefined {
  const zeroPrefix = (count: number): boolean => bytes.slice(0, count).every((byte) => byte === 0);

  // ::ffff:0:0/96（IPv4-mapped）与 ::/96（IPv4-compatible）
  if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) return format4(bytes, 12);
  if (zeroPrefix(12)) return format4(bytes, 12);

  // 64:ff9b::/96（NAT64）
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)) {
    return format4(bytes, 12);
  }

  // 2002::/16（6to4）：内嵌 IPv4 位于第 3–6 字节
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return format4(bytes, 2);

  return undefined;
}

function format4(bytes: Uint8Array, offset: number): string {
  return [0, 1, 2, 3].map((index) => bytes[offset + index] ?? 0).join(".");
}

function ipv4ToInt(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function matchesCidr4(value: number, cidr: string): boolean {
  const [base = "", prefix = ""] = cidr.split("/");
  const baseValue = ipv4ToInt(base);
  const bits = Number(prefix);
  if (baseValue === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

function matchesCidr6(bytes: Uint8Array, cidr: string): boolean {
  const [base = "", prefix = ""] = cidr.split("/");
  const baseBytes = ipv6Bytes(base);
  const bits = Number(prefix);
  if (!baseBytes || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;

  let remaining = bits;
  for (let index = 0; index < 16 && remaining > 0; index += 1) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((baseBytes[index] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function ipv6Bytes(value: string): Uint8Array | undefined {
  const text = value.includes("%") ? value.slice(0, value.indexOf("%")) : value;
  const doubleColon = text.indexOf("::");
  const headText = doubleColon === -1 ? text : text.slice(0, doubleColon);
  const tailText = doubleColon === -1 ? "" : text.slice(doubleColon + 2);

  const head = expandGroups(headText);
  const tail = doubleColon === -1 ? undefined : expandGroups(tailText);
  if (!head || (doubleColon !== -1 && !tail)) return undefined;

  let groups: number[];
  if (doubleColon === -1) {
    groups = head;
  } else {
    const missing = 8 - head.length - (tail?.length ?? 0);
    if (missing < 0) return undefined;
    groups = [...head, ...new Array<number>(missing).fill(0), ...(tail ?? [])];
  }

  if (groups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function expandGroups(part: string): number[] | undefined {
  if (part === "") return [];

  const pieces = part.split(":");
  const groups: number[] = [];

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? "";

    if (piece.includes(".")) {
      // 内嵌 IPv4 只能出现在最后一组。
      if (index !== pieces.length - 1) return undefined;
      const value = ipv4ToInt(piece);
      if (value === undefined) return undefined;
      groups.push((value >>> 16) & 0xffff, value & 0xffff);
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
    groups.push(Number.parseInt(piece, 16));
  }

  return groups;
}
