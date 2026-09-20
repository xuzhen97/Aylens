import type { TransportConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type { HttpTransport, TransportFactory } from "./types.js";

export class TransportRegistry {
  private readonly transports = new Map<string, HttpTransport>();
  private readonly configs = new Map<string, TransportConfig>();
  private readonly factories = new Map<TransportConfig["type"], TransportFactory>();

  registerFactory(factory: TransportFactory): void {
    if (this.factories.has(factory.type)) throw new Error(`Transport factory already registered: ${factory.type}`);
    this.factories.set(factory.type, factory);
  }

  build(id: string, config: TransportConfig): HttpTransport {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(`Transport type is configured but not implemented: ${config.type} (transport: ${id})`);
    }
    const transport = factory.create(id, config);
    this.register(transport);
    this.configs.set(id, config);
    return transport;
  }

  register(transport: HttpTransport): void {
    if (this.transports.has(transport.id)) throw new Error(`Transport already registered: ${transport.id}`);
    this.transports.set(transport.id, transport);
  }

  get(id: string): HttpTransport {
    const transport = this.transports.get(id);
    if (!transport) throw new RetrievalError("NETWORK_ERROR", `Unknown transport: ${id}`);
    return transport;
  }

  getConfig(id: string): TransportConfig {
    const config = this.configs.get(id);
    if (!config) throw new RetrievalError("NETWORK_ERROR", `Unknown transport config: ${id}`);
    return config;
  }

  list(): string[] {
    return [...this.transports.keys()];
  }
}
