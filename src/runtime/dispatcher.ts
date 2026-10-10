import type { ProviderRegistry } from "../providers/registry.js";
import { RetrievalError } from "../core/errors.js";
import { createId } from "../shared/ids.js";
import type { ExtractRequest, ProviderExtractResponse } from "../contracts/extract.js";
import type { SearchRequest } from "../contracts/search.js";
import type { ProviderSearchResponse } from "../contracts/search.js";
import type { ProviderAuthState, ProviderUsageReport } from "../providers/types.js";
import type { RuntimeRegistry } from "./registry.js";
import type { RunnerSessionManager } from "./runner-session-manager.js";
import type {
  RuntimeCapabilities,
  RuntimeExecutionOperation,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeExtractResult,
} from "./types.js";

export class ExecutionDispatcher {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly runtimes: RuntimeRegistry,
    private readonly runnerSessions: RunnerSessionManager,
  ) {}

  private async executeWithRuntime<T>(
    runtimeId: string,
    execute: () => Promise<RuntimeExecutionResult<T>>,
  ): Promise<RuntimeExecutionResult<T>> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof RetrievalError) {
        throw new RetrievalError(error.code, error.message, {
          retryable: error.retryable,
          details: {
            ...error.details,
            runtimeId,
          },
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * 解析并校验目标 Runner。
   *
   * 独立节点放置与 selector 路径合并在此，避免 search/auth/extract 各自复制一份
   * RUNTIME_OFFLINE 与 NO_COMPATIBLE_RUNTIME 判断。
   */
  private resolveRuntime(
    providerId: string,
    operation: RuntimeExecutionOperation,
  ) {
    const definition = this.providers.getDefinition(providerId);
    const target = definition.config.runtime;

    if (target && "nodeId" in target) {
      const runtime = this.runtimes.get(target.nodeId);
      if (!runtime || runtime.status === "offline") {
        throw new RetrievalError("RUNTIME_OFFLINE", `Runtime is offline: ${target.nodeId}`, { retryable: true });
      }
      if (!runtime.capabilities.providerIds.includes(providerId)) {
        throw new RetrievalError("NO_COMPATIBLE_RUNTIME", `Runtime does not deploy provider: ${providerId}`, {
          retryable: true,
        });
      }
      this.assertOperation(runtime, providerId, operation);
      return { definition, runtime };
    }

    // 未配置 placement 时只按逻辑 Provider ID 与 Type 选择已实际部署该 Provider 的 Runner。
    const selector = target?.selector ?? { providerType: definition.config.type };
    const runtime = this.runtimes.select(selector, providerId);
    this.assertOperation(runtime, providerId, operation);
    return { definition, runtime };
  }

  /**
   * 只对新能力 extract 做能力校验。
   *
   * search 与 auth_* 必须维持旧行为：旧 Runner 不上报 providerOperations 但确实支持它们，
   * 若一并拒绝会破坏现有 x-search 登录与搜索。
   */
  private assertOperation(
    runtime: { capabilities: RuntimeCapabilities },
    providerId: string,
    operation: RuntimeExecutionOperation,
  ): void {
    if (operation === "search" || operation === "auth_check" || operation === "auth_login") return;

    const declared = runtime.capabilities.providerOperations?.[providerId];
    if (!declared || !declared.includes(operation)) {
      throw new RetrievalError(
        "NO_COMPATIBLE_RUNTIME",
        `Runtime does not support ${operation} for provider: ${providerId}`,
        { retryable: false },
      );
    }
  }

  async search(
    providerId: string,
    input: SearchRequest,
    context: { requestId: string; traceId: string },
  ): Promise<RuntimeExecutionResult<ProviderSearchResponse>> {
    const { definition, runtime } = this.resolveRuntime(providerId, "search");
    const execution: RuntimeExecutionRequest = {
      jobId: createId("job"),
      executionId: createId("exec"),
      providerId,
      providerType: definition.config.type,
      operation: "search",
      input,
      requestId: context.requestId,
      traceId: context.traceId,
    };

    return this.executeWithRuntime(runtime.id, () =>
      this.runnerSessions.execute<ProviderSearchResponse>(runtime.id, execution)
    );
  }

  /**
   * 独立的 Extract 执行入口。必须由声明了 extract 能力的 Runner 承接，
   * 且调用前已通过 resolveRuntime 的能力校验。
   */
  async extract(
    providerId: string,
    input: ExtractRequest,
    context: { requestId: string; traceId: string },
  ): Promise<RuntimeExtractResult> {
    const { definition, runtime } = this.resolveRuntime(providerId, "extract");
    const execution: RuntimeExecutionRequest = {
      jobId: createId("job"),
      executionId: createId("exec"),
      providerId,
      providerType: definition.config.type,
      operation: "extract",
      input,
      requestId: context.requestId,
      traceId: context.traceId,
    };

    return this.executeWithRuntime(runtime.id, () =>
      this.runnerSessions.execute<ProviderExtractResponse>(runtime.id, execution)
    ) as Promise<RuntimeExtractResult>;
  }

  /**
   * 查询 Provider 用量（可选管理能力）。
   *
   * 与 extract 共用能力校验：未声明 usage 的 Runner 不会被派发，
   * 而不是派过去再由 Provider 静默返回空值。
   */
  async usage(
    providerId: string,
  ): Promise<RuntimeExecutionResult<ProviderUsageReport>> {
    const { definition, runtime } = this.resolveRuntime(providerId, "usage");
    const execution: RuntimeExecutionRequest = {
      jobId: createId("job"),
      executionId: createId("exec"),
      providerId,
      providerType: definition.config.type,
      operation: "usage",
      input: {},
      requestId: createId("usage"),
      traceId: createId("trace"),
    };

    return this.executeWithRuntime(runtime.id, () =>
      this.runnerSessions.execute<ProviderUsageReport>(runtime.id, execution)
    );
  }

  async auth(
    providerId: string,
    action: "check" | "login",
  ): Promise<RuntimeExecutionResult<ProviderAuthState>> {
    const { definition, runtime } = this.resolveRuntime(
      providerId,
      action === "check" ? "auth_check" : "auth_login",
    );
    const execution: RuntimeExecutionRequest = {
      jobId: createId("job"),
      executionId: createId("exec"),
      providerId,
      providerType: definition.config.type,
      operation: action === "check" ? "auth_check" : "auth_login",
      input: {},
      requestId: createId("auth"),
      traceId: createId("trace"),
    };

    return this.executeWithRuntime(runtime.id, () =>
      this.runnerSessions.execute<ProviderAuthState>(runtime.id, execution)
    );
  }
}
