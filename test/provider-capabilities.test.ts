import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ProviderFactory } from "../src/providers/types.js";
import urlFetchPlugin from "../src/providers/url-fetch/index.js";
import xSearchPlugin from "../src/providers/x-search/index.js";

function searchOnly(type: string): ProviderFactory {
  return {
    type,
    capabilities: ["search"],
    create: (id) => ({ id, search: async () => ({ items: [] }) }),
  };
}

describe("provider capability declaration", () => {
  it("exposes declared capabilities per provider type", () => {
    const registry = new ProviderRegistry();
    registry.registerFactory(searchOnly("demo"));
    registry.registerFactory({
      type: "api-demo",
      capabilities: ["search", "extract"],
      create: (id) => ({
        id,
        search: async () => ({ items: [] }),
        extract: async () => ({ items: [] }),
      }),
    });

    expect(registry.capabilitiesOf("demo")).toEqual(["search"]);
    expect(registry.capabilitiesOf("api-demo")).toEqual(["search", "extract"]);
  });

  it("fails closed for unknown provider types", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.capabilitiesOf("missing")).toThrowError(/missing/);
    // hasFactory 是能力上报用的非抛版本:未加载就是 false,不能打挂心跳。
    expect(registry.hasFactory("missing")).toBe(false);
  });

  it("knows which provider types actually have a loaded implementation", () => {
    const registry = new ProviderRegistry();
    registry.registerFactory(searchOnly("demo"));
    expect(registry.hasFactory("demo")).toBe(true);
    expect(registry.hasFactory("url-fetch")).toBe(false);
  });

  it("built-in plugins declare only the operations they implement", () => {
    const urlFactory = urlFetchPlugin.factories[0];
    const xFactory = xSearchPlugin.factories[0];
    expect(urlFactory?.capabilities).toEqual(["search"]);
    expect(xFactory?.capabilities).toEqual(["search"]);
  });
});
