import type { ProviderConfig, ProviderDeploymentConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type {
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

  factoryTypes(): string[] {
    return [...this.factories.keys()];
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }
}
