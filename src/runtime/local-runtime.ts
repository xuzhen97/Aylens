import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderFactoryContext } from "../providers/types.js";
import { LOCAL_RUNTIME_ID } from "./types.js";
import type { ExecutionRuntime, RuntimeExecutionRequest, RuntimeExecutionResult } from "./types.js";

export class LocalRuntime implements ExecutionRuntime {
  readonly id = LOCAL_RUNTIME_ID;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly providerContext: ProviderFactoryContext,
  ) {}

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult> {
    const provider = this.providers.createLocal(request.providerId, this.providerContext);
    const output = await provider.search(
      {
        requestId: request.requestId,
        traceId: request.traceId,
        runtimeId: this.id,
        jobId: request.jobId,
      },
      request.input,
    );
    return { runtimeId: this.id, output };
  }
}
