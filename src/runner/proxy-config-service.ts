import type { RunnerConfig } from "../runner/config.js";
import type { TransportConfig } from "../config/schema.js";
import { ProxyConfigStore } from "./proxy-config-store.js";
import { proxyWriteSchema } from "../runtime/proxy-config-contract.js";
import type {
  ProxyConfigState,
  ProxyWrite,
  SafeProxyConfig,
} from "../runtime/proxy-config-contract.js";

/** 固定分类的安全错误;消息不包含原始地址、凭据或 Zod issue。 */
export class ProxyConfigError extends Error {
  constructor(
    readonly code:
      | "CONFIG_VERSION_CONFLICT"
      | "CONFIG_INVALID"
      | "CONFIG_IN_USE"
      | "CONFIG_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "ProxyConfigError";
  }
}

function splitCredentials(url: URL): { hasCredentials: boolean; username: string | null; password: string | null } {
  if (!url.username && !url.password) {
    return { hasCredentials: false, username: null, password: null };
  }
  return {
    hasCredentials: true,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function parseProxyUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ProxyConfigError("CONFIG_INVALID", "Stored proxy URL is malformed");
  }
}

function proxyUrl(type: string, address: string, credentials: { username: string | null; password: string | null }): string {
  const url = parseProxyUrl(address);
  if (credentials.username !== null || credentials.password !== null) {
    url.username = credentials.username === null ? "" : encodeURIComponent(credentials.username);
    url.password = credentials.password === null ? "" : encodeURIComponent(credentials.password);
  }
  // socks5h 与 socks5 共用 socks5 传输类型;协议本身保留在 URL 中。
  return type === "socks5" && url.protocol === "socks5h:" ? url.toString() : url.toString();
}

/**
 * 代理配置服务:校验引用、执行凭据动作、产出安全视图。
 * 运行切换由执行快照(Task 4)接入;本类只负责持久化与校验。
 */
export class ProxyConfigService {
  constructor(
    private readonly store: ProxyConfigStore,
    private readonly baseConfig: RunnerConfig,
  ) {}

  readState(): ProxyConfigState {
    return this.store.read();
  }

  readSafe(): SafeProxyConfig {
    const state = this.store.read();
    const providerRefs = new Map<string, string[]>();
    const profileRefs = new Map<string, string[]>();
    for (const [providerId, binding] of Object.entries(state.bindings)) {
      if (binding === null) continue;
      const refs = providerRefs.get(binding.primary) ?? [];
      refs.push(providerId);
      providerRefs.set(binding.primary, refs);
      for (const fallbackId of binding.fallback) {
        const fallbackRefs = providerRefs.get(fallbackId) ?? [];
        fallbackRefs.push(providerId);
        providerRefs.set(fallbackId, fallbackRefs);
      }
    }
    for (const [profileId, profile] of Object.entries(this.baseConfig.browserProfiles)) {
      if (!profile.transport) continue;
      const refs = profileRefs.get(profile.transport) ?? [];
      refs.push(profileId);
      profileRefs.set(profile.transport, refs);
    }

    const proxies = Object.entries(state.transports).map(([id, transport]) => {
      let address: string | undefined;
      let hasCredentials = false;
      if (transport.type !== "direct") {
        try {
          const url = new URL(transport.url);
          const credentials = splitCredentials(url);
          hasCredentials = credentials.hasCredentials;
          url.username = "";
          url.password = "";
          address = url.toString();
        } catch {
          address = undefined;
        }
      }
      return {
        id,
        type: transport.type as SafeProxyConfig["proxies"][number]["type"],
        ...(address !== undefined ? { address } : {}),
        hasCredentials,
        providerRefs: providerRefs.get(id) ?? [],
        profileRefs: profileRefs.get(id) ?? [],
      };
    });

    const providers = Object.keys(this.baseConfig.providers).map((providerId) => ({
      id: providerId,
      binding: state.bindings[providerId] ?? null,
    }));

    // 修改被 Profile 引用的代理后,需重启对应 Chrome 才生效;保守提示所有相关 Profile。
    const changedProfileTransports = new Set<string>();
    for (const profile of Object.values(this.baseConfig.browserProfiles)) {
      if (profile.transport) changedProfileTransports.add(profile.transport);
    }
    const browserRestartRequired = [...changedProfileTransports]
      .filter((transportId) => state.transports[transportId]?.type !== "direct")
      .flatMap((transportId) => profileRefs.get(transportId) ?? []);

    return {
      version: state.version,
      ...(state.lastOperationId !== undefined ? { lastOperationId: state.lastOperationId } : {}),
      proxies,
      providers,
      browserRestartRequired,
    };
  }

  /** 应用一次原子写入:先经严格 schema 校验,再校验引用与凭据动作,提交后返回新的安全视图。 */
  write(input: ProxyWrite): SafeProxyConfig {
    const parsed = proxyWriteSchema.safeParse(input);
    if (!parsed.success) {
      // 固定安全消息,不回显 Zod issue 或输入内容。
      throw new ProxyConfigError("CONFIG_INVALID", "Proxy config mutation is invalid");
    }
    const write = parsed.data;
    const state = this.store.read();
    if (!state.initialized) {
      throw new ProxyConfigError("CONFIG_UNSUPPORTED", "Proxy config store is not initialized");
    }
    if (state.version !== write.expectedVersion) {
      throw new ProxyConfigError(
        "CONFIG_VERSION_CONFLICT",
        `Proxy config version conflict: expected ${write.expectedVersion}, current ${state.version}`,
      );
    }

    const next: ProxyConfigState = {
      version: state.version,
      initialized: true,
      transports: { ...state.transports },
      bindings: { ...state.bindings },
    };

    const mutation = write.mutation;
    if (mutation.kind === "put") {
      const existing = state.transports[mutation.id];
      let credentials: { username: string | null; password: string | null };
      if (mutation.credentials.action === "replace") {
        credentials = { username: mutation.credentials.username, password: mutation.credentials.password };
      } else if (mutation.credentials.action === "clear") {
        credentials = { username: null, password: null };
      } else {
        // keep 仅对已有代理有效;新建代理没有可保留的凭据。
        const parsed = existing && existing.type !== "direct"
          ? splitCredentials(parseProxyUrl(existing.url))
          : { username: null, password: null };
        credentials = { username: parsed.username, password: parsed.password };
      }

      next.transports[mutation.id] = {
        type: mutation.type,
        url: proxyUrl(mutation.type, mutation.address, credentials),
      };
    } else if (mutation.kind === "delete") {
      const referenced = Object.entries(state.bindings).some(([, binding]) =>
        binding !== null && (binding.primary === mutation.id || binding.fallback.includes(mutation.id)),
      ) || Object.values(this.baseConfig.browserProfiles).some((profile) => profile.transport === mutation.id);
      if (referenced) {
        throw new ProxyConfigError(
          "CONFIG_IN_USE",
          `Transport is referenced by a provider or browser profile: ${mutation.id}`,
        );
      }
      if (!state.transports[mutation.id]) {
        throw new ProxyConfigError("CONFIG_INVALID", "Unknown transport");
      }
      delete next.transports[mutation.id];
    } else {
      if (!(mutation.providerId in this.baseConfig.providers)) {
        throw new ProxyConfigError("CONFIG_INVALID", "Unknown provider deployment");
      }
      if (mutation.binding === null) {
        next.bindings[mutation.providerId] = null;
      } else {
        const { primary, fallback } = mutation.binding;
        for (const transportId of [primary, ...fallback]) {
          if (!state.transports[transportId]) {
            throw new ProxyConfigError("CONFIG_INVALID", `Unknown transport: ${transportId}`);
          }
        }
        if (fallback.includes(primary) || new Set(fallback).size !== fallback.length) {
          throw new ProxyConfigError("CONFIG_INVALID", "Fallback transports must be unique and differ from primary");
        }
        next.bindings[mutation.providerId] = { primary, fallback: [...fallback] };
      }
    }

    this.store.commit(next, write.expectedVersion, write.operationId);
    return this.readSafe();
  }

  /** 组装当前生效的私密 TransportConfig 映射(仅 Runner 内部使用)。 */
  transportConfigs(): Record<string, TransportConfig> {
    const state = this.store.read();
    const configs: Record<string, TransportConfig> = {};
    for (const [id, transport] of Object.entries(state.transports)) {
      if (transport.type === "direct") {
        configs[id] = { type: "direct" };
      } else {
        configs[id] = { type: transport.type as "http-proxy" | "socks5", url: transport.url } as TransportConfig;
      }
    }
    return configs;
  }
}
