import type { InMemoryAuditService } from "../audit/audit-service.js";
import type { SearchRequest, SearchResponse } from "../contracts/search.js";
import { RetrievalError, toErrorPayload } from "../core/errors.js";
import type { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { createId } from "../shared/ids.js";
import type { ProviderRouter } from "./router.js";

export class SearchService {
  constructor(
    private readonly router: ProviderRouter,
    private readonly dispatcher: ExecutionDispatcher,
    private readonly audit: InMemoryAuditService,
  ) {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    const requestId = createId("srch");
    const traceId = createId("trace");
    const providers = this.router.resolve(request);
    this.audit.start(requestId, traceId, request);

    const items: SearchResponse["items"] = [];
    const meta: SearchResponse["meta"]["providers"] = {};

    await Promise.all(providers.map(async (providerId) => {
      const startedAt = Date.now();
      try {
        const result = await this.dispatcher.search(providerId, request, { requestId, traceId });
        items.push(...result.output.items);
        meta[providerId] = {
          status: "success",
          runtimeId: result.runtimeId,
          latencyMs: Date.now() - startedAt,
          resultCount: result.output.items.length,
        };
        this.audit.addProviderEvent(requestId, {
          providerId,
          runtimeId: result.runtimeId,
          startedAt,
          completedAt: Date.now(),
          status: "success",
          resultCount: result.output.items.length,
        });
      } catch (error) {
        const payload = toErrorPayload(error);
        const runtimeId = error instanceof RetrievalError && typeof error.details?.runtimeId === "string"
          ? error.details.runtimeId
          : undefined;
        meta[providerId] = {
          status: "failed",
          ...(runtimeId ? { runtimeId } : {}),
          latencyMs: Date.now() - startedAt,
          resultCount: 0,
          error: payload,
        };
        this.audit.addProviderEvent(requestId, {
          providerId,
          ...(runtimeId ? { runtimeId } : {}),
          startedAt,
          completedAt: Date.now(),
          status: "failed",
          errorCode: payload.code,
          resultCount: 0,
        });
      }
    }));

    const successes = Object.values(meta).filter((value) => value.status === "success").length;
    const failures = Object.values(meta).filter((value) => value.status === "failed").length;
    const status = failures === 0 ? "completed" : successes > 0 ? "partial" : "failed";
    this.audit.finish(requestId, status);

    return {
      requestId,
      traceId,
      status,
      items: items.slice(0, request.limit ?? 20),
      meta: { providers: meta },
    };
  }
}
