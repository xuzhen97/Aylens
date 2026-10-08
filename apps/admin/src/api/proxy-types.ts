/**
 * Admin 前端代理配置 DTO:独立定义,不导入服务端运行模块。
 * 与 Gateway SafeProxyConfig/ProxyWrite 契约保持字段一致。
 */

export type ProviderTransportBinding = {
  primary: string;
  fallback: string[];
};

export type ProxySummary = {
  id: string;
  type: "direct" | "http-proxy" | "socks5";
  address?: string;
  hasCredentials: boolean;
  providerRefs: string[];
  profileRefs: string[];
};

export type SafeProxyConfig = {
  version: number;
  lastOperationId?: string;
  proxies: ProxySummary[];
  providers: Array<{ id: string; binding: ProviderTransportBinding | null }>;
  browserRestartRequired: string[];
};

export type CredentialChange =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "replace"; username: string; password: string };

export type ProxyMutation =
  | { kind: "put"; id: string; type: "http-proxy" | "socks5"; address: string; credentials: CredentialChange }
  | { kind: "delete"; id: string }
  | { kind: "bind"; providerId: string; binding: ProviderTransportBinding | null };

export type ProxyWrite = {
  operationId: string;
  expectedVersion: number;
  mutation: ProxyMutation;
};
