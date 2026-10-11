import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";

function buildRegistry(overrides?: ReadonlyMap<string, boolean>) {
  const registry = new ProviderRegistry(overrides);
  // tavily 在配置文件里默认禁用；url-fetch 默认启用。
  registry.addDefinition("tavily", { type: "tavily", enabled: false });
  registry.addDefinition("url-fetch", { type: "url-fetch", enabled: true });
  return registry;
}

/** RetrievalError 的 code 断言：避免依赖 message 文案。 */
function errorCode(work: () => unknown): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("ProviderRegistry enablement overlay", () => {
  it("lets an override enable a provider that the config file disables", () => {
    const registry = buildRegistry(new Map([["tavily", true]]));
    expect(registry.getDefinition("tavily").id).toBe("tavily");
    expect(registry.list().find((item) => item.id === "tavily"))
      .toMatchObject({ enabled: true, enabledMode: "enabled" });
  });

  it("lets an override disable a provider that the config file enables", () => {
    const registry = buildRegistry(new Map([["url-fetch", false]]));
    expect(errorCode(() => registry.getDefinition("url-fetch"))).toBe("PROVIDER_DISABLED");
    expect(registry.list().find((item) => item.id === "url-fetch"))
      .toMatchObject({ enabled: false, enabledMode: "disabled" });
  });

  it("falls back to the config value when there is no override", () => {
    const registry = buildRegistry();
    expect(registry.list().find((item) => item.id === "tavily"))
      .toMatchObject({ enabled: false, enabledMode: "config" });
    expect(registry.list().find((item) => item.id === "url-fetch"))
      .toMatchObject({ enabled: true, enabledMode: "config" });
    expect(errorCode(() => registry.getDefinition("tavily"))).toBe("PROVIDER_DISABLED");
  });

  it("still finds a disabled provider through findDefinition", () => {
    // INV-1 回归：控制面必须能看见已禁用的 Provider，否则无法重新启用它。
    const registry = buildRegistry(new Map([["tavily", false]]));
    expect(errorCode(() => registry.getDefinition("tavily"))).toBe("PROVIDER_DISABLED");
    expect(registry.findDefinition("tavily")?.id).toBe("tavily");
    expect(registry.findDefinition("ghost")).toBeUndefined();
  });

  it("clears an override with applyOverride(id, undefined)", () => {
    const registry = buildRegistry(new Map([["tavily", true]]));
    registry.applyOverride("tavily", undefined);
    expect(registry.list().find((item) => item.id === "tavily"))
      .toMatchObject({ enabled: false, enabledMode: "config" });
    registry.applyOverride("url-fetch", false);
    expect(registry.list().find((item) => item.id === "url-fetch"))
      .toMatchObject({ enabled: false, enabledMode: "disabled" });
  });
});
