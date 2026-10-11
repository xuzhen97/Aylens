import type { ProviderConfig, ProviderDeploymentConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type {
  ProviderCapability,
  ProviderDefinition,
  ProviderFactory,
  ProviderFactoryContext,
  SearchProvider,
} from "./types.js";

/**
 * 启用态：显式启用、显式禁用，或跟随配置文件。
 * "config" 表示当前没有覆盖行，生效值来自 config/aylens.yaml。
 */
export type ProviderEnabledMode = "enabled" | "disabled" | "config";

export interface ProviderDefinitionState {
  id: string;
  /**
   * 配置文件的静态定义，但**刻意去掉 `enabled`**。
   *
   * 生效值看最外层的 `enabled`；由于这里没有 `config.enabled`，
   * 任何调用方再读静态值都会变成**编译错误**，而不是静默显示过期状态（INV-3）。
   */
  config: Omit<ProviderConfig, "enabled">;
  /** 生效值：覆盖值 ?? 配置文件默认值。 */
  enabled: boolean;
  enabledMode: ProviderEnabledMode;
}

/** 剔除 `enabled`：类型上强制调用方读外层生效值，而不是配置里的静态默认值。 */
function withoutEnabled(config: ProviderConfig): Omit<ProviderConfig, "enabled"> {
  const { enabled, ...rest } = config;
  void enabled;
  return rest;
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();
  private readonly factories = new Map<string, ProviderFactory>();
  /** 只存偏离：有键即代表存在操作员覆盖。 */
  private readonly overrides = new Map<string, boolean>();

  constructor(overrides: ReadonlyMap<string, boolean> = new Map()) {
    for (const [id, enabled] of overrides) this.overrides.set(id, enabled);
  }

  registerFactory(factory: ProviderFactory): void {
    if (this.factories.has(factory.type)) throw new Error(`Provider factory already registered: ${factory.type}`);
    this.factories.set(factory.type, factory);
  }

  addDefinition(id: string, config: ProviderConfig): void {
    if (this.definitions.has(id)) throw new Error(`Provider already defined: ${id}`);
    this.definitions.set(id, { id, config });
  }

  private effectiveEnabled(definition: ProviderDefinition): boolean {
    return this.overrides.get(definition.id) ?? definition.config.enabled;
  }

  private enabledModeOf(id: string): ProviderEnabledMode {
    const override = this.overrides.get(id);
    if (override === undefined) return "config";
    return override ? "enabled" : "disabled";
  }

  /**
   * 不做启用检查的查找。
   *
   * 控制面写接口必须用它：已禁用的 Provider 在 getDefinition 下会抛
   * PROVIDER_DISABLED，用它定位目标会导致"停用后再也启不回来"。
   */
  findDefinition(id: string): ProviderDefinition | undefined {
    return this.definitions.get(id);
  }

  /** 更新内存覆盖层；undefined 表示清除覆盖、回落到配置文件。 */
  applyOverride(id: string, enabled: boolean | undefined): void {
    if (enabled === undefined) this.overrides.delete(id);
    else this.overrides.set(id, enabled);
  }

  getDefinition(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new RetrievalError("PROVIDER_UNAVAILABLE", `Unknown provider: ${id}`);
    if (!this.effectiveEnabled(definition)) {
      throw new RetrievalError("PROVIDER_DISABLED", `Provider disabled: ${id}`);
    }
    return definition;
  }

  create(
    id: string,
    config: ProviderDeploymentConfig,
    context: ProviderFactoryContext,
  ): SearchProvider {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new RetrievalError(
        "PROVIDER_UNAVAILABLE",
        `No implementation registered for provider type: ${config.type}`,
      );
    }
    return factory.create(id, config, context);
  }

  supportsAuth(type: string): boolean {
    return this.factories.get(type)?.authControl === true;
  }

  /** 该 type 是否有已加载的实现。用于能力上报：未加载就不上报，不让心跳抛错。 */
  hasFactory(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * Provider type 声明的操作能力。未知 type 明确失败(fail closed),
   * 不假定 search:否则未实现的 extract 会被当成支持并错误派发。
   */
  capabilitiesOf(type: string): readonly ProviderCapability[] {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new RetrievalError(
        "PROVIDER_UNAVAILABLE",
        `No implementation registered for provider type: ${type}`,
      );
    }
    return factory.capabilities;
  }

  factoryTypes(): string[] {
    return [...this.factories.keys()];
  }

  list(): ProviderDefinitionState[] {
    return [...this.definitions.values()].map((definition) => ({
      id: definition.id,
      config: withoutEnabled(definition.config),
      enabled: this.effectiveEnabled(definition),
      enabledMode: this.enabledModeOf(definition.id),
    }));
  }
}
