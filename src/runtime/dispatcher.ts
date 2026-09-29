import type { ProviderRegistry } from "../providers/registry.js";
import { RetrievalError } from "../core/errors.js";
import { createId } from "../shared/ids.js";
import type { SearchRequest } from "../contracts/search.js";
import type { RuntimeRegistry } from "./registry.js";
import type { RunnerSessionManager } from "./runner-session-manager.js";
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from "./types.js";

export class ExecutionDispatcher {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly runtimes: RuntimeRegistry,
    private readonly runnerSessions: RunnerSessionManager,
  ) {}

  private async executeWithRuntime(
    runtimeId: string,
    execute: () => Promise<RuntimeExecutionResult>,
  ): Promise<RuntimeExecutionResult> {
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

  async search(
    providerId: string,
    input: SearchRequest,
    context: { requestId: string; traceId: string },
  ): Promise<RuntimeExecutionResult> {
    const definition = this.providers.getDefinition(providerId);
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
      return this.executeWithRuntime(runtime.id, () => this.runnerSessions.execute(runtime.id, execution));
    }

    // 未配置 placement 时只按逻辑 Provider ID 与 Type 选择已实际部署该 Provider 的 Runner。
    const selector = target?.selector ?? { providerType: definition.config.type };
    const runtime = this.runtimes.select(selector, providerId);
    return this.executeWithRuntime(runtime.id, () => this.runnerSessions.execute(runtime.id, execution));
  }
}
