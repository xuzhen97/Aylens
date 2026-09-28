import type { ProviderRegistry } from "../providers/registry.js";
import { RetrievalError } from "../core/errors.js";
import { createId } from "../shared/ids.js";
import type { SearchRequest } from "../contracts/search.js";
import type { RuntimeRegistry } from "./registry.js";
import type { LocalRuntime } from "./local-runtime.js";
import type { RunnerSessionManager } from "./runner-session-manager.js";
import { LOCAL_RUNTIME_ID } from "./types.js";
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from "./types.js";

export class ExecutionDispatcher {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly runtimes: RuntimeRegistry,
    private readonly localRuntime: LocalRuntime,
    private readonly runnerSessions: RunnerSessionManager,
  ) {}

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
      providerConfig: definition.config,
      operation: "search",
      input,
      requestId: context.requestId,
      traceId: context.traceId,
    };

    const target = definition.config.runtime;

    if ("mode" in target) {
      if (target.mode !== "local") throw new RetrievalError("INTERNAL_ERROR", "Unsupported local runtime mode");
      return this.localRuntime.execute(execution);
    }

    if ("nodeId" in target) {
      // `nodeId` names a remote Runner. The Gateway's own record is reachable
      // through `runtime.mode = "local"` instead, and pinning it here would only
      // produce a confusing "Runtime is not connected: local".
      if (target.nodeId === LOCAL_RUNTIME_ID) {
        throw new RetrievalError(
          "INTERNAL_ERROR",
          'runtime.nodeId cannot be "local"; use runtime.mode = "local" to execute on the Gateway',
        );
      }

      const runtime = this.runtimes.get(target.nodeId);
      if (!runtime || runtime.status === "offline") {
        throw new RetrievalError("RUNTIME_OFFLINE", `Runtime is offline: ${target.nodeId}`, { retryable: true });
      }
      return this.runnerSessions.execute(runtime.id, execution);
    }

    const runtime = this.runtimes.select(target.selector);
    return this.runnerSessions.execute(runtime.id, execution);
  }
}
