import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

function isLoopbackAddress(value: string): boolean {
  let address = value;
  // IPv4-mapped IPv6(::ffff:127.0.0.1)按 IPv4 回环处理。
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1" || address === "localhost") return true;
  const version = isIP(address);
  return version === 4 && address.split(".")[0] === "127";
}

function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 判断 Runner WebSocket upgrade 是否满足“安全或本机”要求。
 *
 * - 客户端直连 TLS(wss)即安全;
 * - 否则仅当连接来自明确配置的可信代理,且其声明的原始协议为 https 时安全;
 * - loopback 直连(无 TLS)按本机开发例外处理;
 * - 远端对端配合 localhost Host 头不构成例外;不信任任意转发头。
 */
export function upgradeIsSecureOrLocal(
  request: {
    socketRemoteAddress: string | undefined;
    headers: IncomingHttpHeaders;
    isTls?: boolean;
  },
  trustedProxies: readonly string[],
): boolean {
  if (request.isTls) return true;

  const forwardedProto = firstForwardedValue(request.headers["x-forwarded-proto"]);
  const peer = request.socketRemoteAddress ?? "";
  const peerIsTrustedProxy = trustedProxies.some((trusted) => trusted === peer);

  if (forwardedProto === "https" && peerIsTrustedProxy) return true;

  // Host 头只能用于本机开发例外的辅助判断;真正的依据是对端地址本身是回环。
  const host = firstForwardedValue(request.headers.host) ?? "";
  const hostIsLocal = host.split(":")[0] === "localhost" || host.split(":")[0]?.endsWith(".localhost") === true;
  return isLoopbackAddress(peer) || (hostIsLocal && isLoopbackAddress(peer));
}
