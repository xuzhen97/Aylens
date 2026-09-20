import type { AppConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type { SearchRequest } from "../contracts/search.js";

export class ProviderRouter {
  constructor(private readonly config: AppConfig) {}

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
