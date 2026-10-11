import type { ProviderEnabledMode, ProviderRegistry } from "./registry.js";
import type { ProviderSettingStore } from "./provider-setting-store.js";

/**
 * 目标 Provider 不存在。
 *
 * 这里是领域错误，不认识 HTTP：由路由层映射为 404 PROVIDER_NOT_FOUND。
 * 复用 RetrievalError 会把 404 变成 503，且让"写错了 ID"和"上游挂了"无法区分。
 */
export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = "ProviderNotFoundError";
  }
}

export interface ProviderEnabledState {
  providerId: string;
  enabled: boolean;
  enabledMode: ProviderEnabledMode;
  /** 当前生效值来自覆盖层还是配置文件。 */
  enabledSource: "override" | "config";
}

/**
 * 启用态编排：磁盘是权威、registry 内存映射是缓存。
 *
 * 顺序固定为"先落库成功，再更新内存"（INV-5）：
 * 落库失败时不得改变运行期生效值，否则界面与实际行为会分叉。
 */
export class ProviderSettingService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly store: ProviderSettingStore,
    private readonly now: () => number = Date.now,
  ) {}

  setMode(providerId: string, mode: ProviderEnabledMode): ProviderEnabledState {
    // 必须用 findDefinition：getDefinition 对已禁用的 Provider 会抛错，
    // 会让"停用后再启用"永远失败（INV-1）。
    if (!this.registry.findDefinition(providerId)) throw new ProviderNotFoundError(providerId);

    if (mode === "config") this.store.clear(providerId);
    else this.store.set(providerId, mode === "enabled", this.now());

    this.registry.applyOverride(providerId, mode === "config" ? undefined : mode === "enabled");
    return this.stateOf(providerId);
  }

  stateOf(providerId: string): ProviderEnabledState {
    const state = this.registry.list().find((item) => item.id === providerId);
    if (!state) throw new ProviderNotFoundError(providerId);
    return {
      providerId,
      enabled: state.enabled,
      enabledMode: state.enabledMode,
      enabledSource: state.enabledMode === "config" ? "config" : "override",
    };
  }
}
