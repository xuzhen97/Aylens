import { describe, expect, it } from "vitest";
import { ExecutionDispatcher } from "../src/runtime/dispatcher.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import type { RuntimeRegistry } from "../src/runtime/registry.js";
import type { RunnerSessionManager } from "../src/runtime/runner-session-manager.js";
import type { RuntimeCapabilities } from "../src/runtime/types.js";

/**
 * capability 声明驱动的派发校验。
 *
 * - 声明了 extract → 可派发;
 * - 未声明 extract（或旧 Runner 完全不带 providerOperations）→ 明确拒绝，
 *   而不是乐观派发到一个不会处理该 operation 的 Runner;
 * - search 与 auth_* 不受该检查影响，保持旧 Runner 行为。
 */
function harness(providerOperations: Record<string, RuntimeCapabilities["providerOperations"]> extends never ? never : RuntimeCapabilities["providerOperations"]) {
  const executed: Array<{ operation: string; providerId: string }> = [];
  const providers = {
    getDefinition: () => ({ id: "tavily", config: { type: "tavily", enabled: true } }),
  } as unknown as ProviderRegistry;
  const runtimes = {
    select: () => ({
      id: "runner-1",
      status: "online",
      capabilities: {
        providerTypes: ["tavily"],
        providerIds: ["tavily"],
        browsers: [],
        profiles: [],
        http: true,
        browserAutomation: false,
        ...(providerOperations ? { providerOperations } : {}),
      },
    }),
  } as unknown as RuntimeRegistry;
  const sessions = {
    execute: async (_id: string, request: { operation: string; providerId: string }) => {
      executed.push({ operation: request.operation, providerId: request.providerId });
      return { runtimeId: "runner-1", output: { items: [] } };
    },
  } as unknown as RunnerSessionManager;
  return { dispatcher: new ExecutionDispatcher(providers, runtimes, sessions), executed };
}

const extractInput = { urls: ["https://a.example"], sources: ["tavily"] };

describe("extract dispatch", () => {
  it("dispatches extract when the runner declares the capability", async () => {
    const { dispatcher, executed } = harness({ tavily: ["search", "extract"] });
    const result = await dispatcher.extract("tavily", extractInput, { requestId: "r", traceId: "t" });
    expect(result.runtimeId).toBe("runner-1");
    expect(executed).toEqual([{ operation: "extract", providerId: "tavily" }]);
  });

  it("refuses extract on runners that only declare search", async () => {
    const { dispatcher, executed } = harness({ tavily: ["search"] });
    await expect(dispatcher.extract("tavily", extractInput, { requestId: "r", traceId: "t" }))
      .rejects.toMatchObject({ code: "NO_COMPATIBLE_RUNTIME" });
    expect(executed).toEqual([]);
  });

  it("treats legacy runners without providerOperations as search-only", async () => {
    const { dispatcher, executed } = harness(undefined);
    await expect(dispatcher.extract("tavily", extractInput, { requestId: "r", traceId: "t" }))
      .rejects.toMatchObject({ code: "NO_COMPATIBLE_RUNTIME" });
    expect(executed).toEqual([]);
  });

  it("keeps search working for legacy runners that never declare capabilities", async () => {
    const { dispatcher, executed } = harness(undefined);
    await dispatcher.search("tavily", { query: "hello" }, { requestId: "r", traceId: "t" });
    expect(executed).toEqual([{ operation: "search", providerId: "tavily" }]);
  });

  it("keeps auth working for legacy runners that never declare capabilities", async () => {
    const { dispatcher, executed } = harness(undefined);
    await dispatcher.auth("tavily", "check");
    expect(executed).toEqual([{ operation: "auth_check", providerId: "tavily" }]);
  });

  it("fails with PROVIDER_UNAVAILABLE when the provider is unknown", async () => {
    const providers = {
      getDefinition: () => {
        throw new Error("Unknown provider: nope");
      },
    } as unknown as ProviderRegistry;
    const dispatcher = new ExecutionDispatcher(
      providers,
      {} as unknown as RuntimeRegistry,
      {} as unknown as RunnerSessionManager,
    );
    await expect(dispatcher.extract("nope", extractInput, { requestId: "r", traceId: "t" }))
      .rejects.toThrowError(/Unknown provider/);
  });
});
