import type { AppConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type { SearchRequest } from "../contracts/search.js";

export class ProviderRouter {
  constructor(private readonly config: AppConfig) {}

  /**
   * Extract 必须显式给出来源：第一期不默认并行调用所有提取服务，
   * 也不默认挑选某个来源——由调用方决定往哪里发送 URL。
   */
  resolveExplicit(sources: string[]): string[] {
    const unique = [...new Set(sources)];
    if (unique.length === 0) {
      throw new RetrievalError("INVALID_REQUEST", "Extract requires at least one source");
    }
    for (const providerId of unique) {
      if (!(providerId in this.config.providers)) {
        throw new RetrievalError("PROVIDER_UNAVAILABLE", `Unknown provider: ${providerId}`);
      }
    }
    return unique;
  }

  resolve(request: SearchRequest): string[] {
    if (request.sources?.length) {
      for (const providerId of request.sources) {
        if (!(providerId in this.config.providers)) {
          throw new RetrievalError("PROVIDER_UNAVAILABLE", `Unknown provider: ${providerId}`);
        }
      }
      return [...new Set(request.sources)];
    }

    const routeId = request.route ?? "default";
    const route = this.config.routes[routeId];
    if (!route) throw new RetrievalError("INVALID_REQUEST", `Unknown route: ${routeId}`);
    return route.providers;
  }
}
