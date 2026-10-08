import type { AuditService } from "../audit/audit-service.js";
import type { SearchRequest, SearchResponse } from "../contracts/search.js";
import { RetrievalError, toErrorPayload } from "../core/errors.js";
import type { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { createId } from "../shared/ids.js";
import type { ProviderRouter } from "./router.js";

export class SearchService {
  constructor(
    private readonly router: ProviderRouter,
    private readonly dispatcher: ExecutionDispatcher,
    private readonly audit: AuditService,
  ) {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    const requestId = createId("srch");
    const traceId = createId("trace");
    const providers = this.router.resolve(request);

    // 审计写入失败绝不能伪装成 Provider 失败:先单独尝试 start,失败则不派发任何任务。
    try {
      this.audit.start(requestId, traceId, request);
    } catch {
      throw new RetrievalError("AUDIT_STORAGE_FAILED", "Audit persistence failed", { retryable: false });
    }

    const items: SearchResponse["items"] = [];
    const meta: SearchResponse["meta"]["providers"] = {};
    let auditFailed = false;

    const recordProviderEvent = (event: Parameters<AuditService["addProviderEvent"]>[1]) => {
      try {
        this.audit.addProviderEvent(requestId, event);
      } catch {
        auditFailed = true;
      }
    };

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
        recordProviderEvent({
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
        recordProviderEvent({
          providerId,
          ...(runtimeId ? { runtimeId } : {}),
          startedAt,
          completedAt: Date.now(),
          status: "failed",
          errorCode: payload.code,
          resultCount: 0,
        });
      }
      return undefined;
    }));

    const successes = Object.values(meta).filter((value) => value.status === "success").length;
    const failures = Object.values(meta).filter((value) => value.status === "failed").length;
    const status = failures === 0 ? "completed" : successes > 0 ? "partial" : "failed";

    // finish 同样独立于执行结果:失败只声明审计故障,不改变已确定的执行状态。
    try {
      this.audit.finish(requestId, status);
    } catch {
      auditFailed = true;
    }

    if (auditFailed) {
      throw new RetrievalError("AUDIT_STORAGE_FAILED", "Audit persistence failed", { retryable: false });
    }

    return {
      requestId,
      traceId,
      status,
      items: items.slice(0, request.limit ?? 20),
      meta: { providers: meta },
    };
  }
}
