import type { AuditService } from "../audit/audit-service.js";
import { toSafeExtractRequest } from "../audit/safe-request.js";
import type {
  ExtractItem,
  ExtractItemError,
  ExtractRequest,
  ExtractResponse,
  ProviderExtractResponse,
} from "../contracts/extract.js";
import { RetrievalError, toErrorPayload } from "../core/errors.js";
import type { ExecutionDispatcher } from "../runtime/dispatcher.js";
import { createId } from "../shared/ids.js";
import type { ProviderRouter } from "../search/router.js";

interface ProviderRun {
  providerId: string;
  output: ProviderExtractResponse;
}

/**
 * Extract 执行服务。
 *
 * 与 SearchService 同构（审计 → 派发 → 聚合），但状态按**逐 URL 结果**判定，
 * 而不是按 provider 是否抛错判定：上游可以 HTTP 200 却部分 URL 失败，
 * 只看 provider 状态会把“有 URL 没抓到”标成 completed，与 ADR 要求相反。
 */
export class ExtractService {
  constructor(
    private readonly router: ProviderRouter,
    private readonly dispatcher: ExecutionDispatcher,
    private readonly audit: AuditService,
  ) {}

  async extract(request: ExtractRequest): Promise<ExtractResponse> {
    const requestId = createId("srch");
    const traceId = createId("trace");
    const providers = this.router.resolveExplicit(request.sources);

    // 审计写入失败绝不伪装成 Provider 失败：先单独尝试 start，失败则不派发任何任务。
    try {
      this.audit.start(requestId, traceId, toSafeExtractRequest(request), "extract");
    } catch {
      throw new RetrievalError("AUDIT_STORAGE_FAILED", "Audit persistence failed", { retryable: false });
    }

    const runs: ProviderRun[] = [];
    const meta: ExtractResponse["meta"]["providers"] = {};
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
        const result = await this.dispatcher.extract(providerId, request, { requestId, traceId });
        runs.push({ providerId, output: result.output });
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

    const items = mergeItems(runs, providers, request, meta);
    const status = aggregateStatus(items, meta, providers);

    try {
      this.audit.finish(requestId, status);
    } catch {
      auditFailed = true;
    }

    if (auditFailed) {
      throw new RetrievalError("AUDIT_STORAGE_FAILED", "Audit persistence failed", { retryable: false });
    }

    return { requestId, traceId, status, items, meta: { providers: meta } };
  }
}

/**
 * 把各 Provider 的结果按输入索引合并。
 *
 * 同一 index 可能被多个 Provider 同时返回：优先保留成功项（失败的 Provider 不能
 * 掩盖另一个 Provider 已抓到的内容）；同为成功或同为失败时按 sources 声明顺序取先者，
 * 保证相同输入重复调用得到相同输出（不能依赖 Promise 完成顺序）。
 *
 * **没有任何 Provider 给出结果的输入索引必须补成显式失败**：否则调用方拿到的
 * items 比 urls 短，却无从知道是哪个 URL 没被处理，属静默丢数据。
 */
function mergeItems(
  runs: ProviderRun[],
  providers: string[],
  request: ExtractRequest,
  meta: ExtractResponse["meta"]["providers"],
): ExtractResponse["items"] {
  interface Merged { item: ExtractItem; sourceOrder: number }
  const byIndex = new Map<number, Merged>();
  const sourceOrder = new Map(providers.map((providerId, position) => [providerId, position]));

  for (const run of runs) {
    const order = sourceOrder.get(run.providerId) ?? Number.MAX_SAFE_INTEGER;
    for (const item of run.output.items) {
      // 丢弃越界索引：不能让上游多回的项污染调用方的输入对应关系。
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= request.urls.length) continue;

      const current = byIndex.get(item.index);
      if (!current) {
        byIndex.set(item.index, { item: { ...item }, sourceOrder: order });
        continue;
      }

      const replacement = current.item.status === "failed"
        ? item.status === "success"
        : current.item.status === item.status && order < current.sourceOrder;
      if (replacement) byIndex.set(item.index, { item: { ...item }, sourceOrder: order });
    }
  }

  // 输入里还没被任何 Provider 覆盖的 URL：显式标为失败，不静默消失。
  // 只取失败原因的 code/retryable（两者都是已知的本地枚举），
  // message 一律用本地固定文案：meta.message 可能来自原始 Error，不能当安全文案回传。
  const providerFailure = providers
    .map((providerId) => meta[providerId])
    .find((value) => value?.status === "failed" && value.error !== undefined);
  for (let index = 0; index < request.urls.length; index += 1) {
    if (byIndex.has(index)) continue;
    const error: ExtractItemError = providerFailure?.error
      ? { code: providerFailure.error.code, message: NO_RESULT_MESSAGE, retryable: providerFailure.error.retryable }
      : { code: "CONTENT_UNAVAILABLE", message: NO_RESULT_MESSAGE, retryable: false };
    byIndex.set(index, {
      item: { index, url: request.urls[index] as string, status: "failed", error },
      sourceOrder: Number.MAX_SAFE_INTEGER,
    });
  }

  const limit = request.limit;
  const sorted = [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, merged]) => merged.item);

  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/** 本地固定文案：不携带上游或原始 Error 的 message。 */
const NO_RESULT_MESSAGE = "No provider returned a result for this URL";

/**
 * 状态判定规则（Spec §4.2）：
 * - 完全没有成功项 → failed（成功零项不得为 completed）；
 * - 有成功但也有失败、或有 Provider 异常、或有 Provider 空手而归 → partial；
 * - 全部成功 → completed。
 *
 * “Provider 成功但返回 0 项”算异常：提取请求里每个 URL 都应有明确成败，
 * 静默返回空数组属于不完整的执行，不能标成 completed。
 */
function aggregateStatus(
  items: ExtractResponse["items"],
  meta: ExtractResponse["meta"]["providers"],
  providers: string[],
): ExtractResponse["status"] {
  const successes = items.filter((item) => item.status === "success").length;
  const failures = items.filter((item) => item.status === "failed").length;
  const providerFailed = Object.values(meta).filter((value) => value.status === "failed").length;
  const providerEmpty = providers.filter((providerId) => meta[providerId]?.resultCount === 0).length;

  if (items.length === 0 || (successes === 0 && failures > 0)) return "failed";
  if (failures > 0 || providerFailed > 0 || providerEmpty > 0) return "partial";
  return "completed";
}
