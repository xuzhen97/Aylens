import { describe, expect, it } from "vitest";
import { loadProviderPlugins } from "../src/providers/plugin.js";

describe("Provider plugin loader", () => {
  it("loads configured local provider modules", async () => {
    const loaded = await loadProviderPlugins(
      ["./test/fixtures/fake-provider-plugin.mjs"],
      process.cwd(),
    );

    expect(loaded.plugins.map((plugin) => plugin.name)).toEqual([
      "fixture-provider-plugin",
    ]);
    expect(loaded.factories.map((factory) => factory.type)).toEqual([
      "fixture-remote",
    ]);
  });
});
