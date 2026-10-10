import type { ProviderConfig, ProviderDeploymentConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type {
  ProviderCapability,
  ProviderDefinition,
  ProviderFactory,
  ProviderFactoryContext,
  SearchProvider,
} from "./types.js";

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();
  private readonly factories = new Map<string, ProviderFactory>();

  registerFactory(factory: ProviderFactory): void {
    if (this.factories.has(factory.type)) throw new Error(`Provider factory already registered: ${factory.type}`);
    this.factories.set(factory.type, factory);
  }

  addDefinition(id: string, config: ProviderConfig): void {
    if (this.definitions.has(id)) throw new Error(`Provider already defined: ${id}`);
    this.definitions.set(id, { id, config });
  }

  getDefinition(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new RetrievalError("PROVIDER_UNAVAILABLE", `Unknown provider: ${id}`);
    if (!definition.config.enabled) throw new RetrievalError("PROVIDER_DISABLED", `Provider disabled: ${id}`);
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

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }
}
