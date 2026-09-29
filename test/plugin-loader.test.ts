import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
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

  it("loads packaged .aylens-provider archives", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aylens-provider-"));
    const previousHome = process.env.AYLENS_HOME;
    process.env.AYLENS_HOME = join(temp, "home");

    try {
      const source = await readFile(join(process.cwd(), "test/fixtures/fake-provider-plugin.mjs"));
      const manifest = {
        formatVersion: 1,
        name: "fixture-provider-plugin",
        version: "1.0.0",
        apiVersion: "1",
        entry: "index.mjs",
        providerTypes: ["fixture-remote"],
      };
      const archivePath = join(temp, "fixture.aylens-provider");
      await writeFile(archivePath, zipSync({
        "provider.json": strToU8(JSON.stringify(manifest)),
        "index.mjs": source,
      }));

      const loaded = await loadProviderPlugins([archivePath], temp);
      expect(loaded.plugins.map((plugin) => plugin.name)).toEqual(["fixture-provider-plugin"]);
      expect(loaded.factories.map((factory) => factory.type)).toEqual(["fixture-remote"]);
    } finally {
      if (previousHome === undefined) delete process.env.AYLENS_HOME;
      else process.env.AYLENS_HOME = previousHome;
      await rm(temp, { recursive: true, force: true });
    }
  });
});
