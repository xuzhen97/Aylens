import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadProviderPlugins } from "../src/providers/plugin.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import type { ProviderFactoryContext } from "../src/providers/types.js";
import { CredentialPool } from "../src/runner/credentials/pool.js";

const archive = resolve("release/providers/exa.aylens-provider");

/**
 * Exa 独立 Provider 包的自包含验证。
 *
 * 包会解到**源码目录之外**加载：Node 无法向上解析到仓库的 node_modules，
 * 任何未被打进包的运行时依赖都会在这里以 MODULE_NOT_FOUND 暴露。
 */
const suite = existsSync(archive) ? describe : describe.skip;

class FakeTransport implements HttpTransport {
  readonly id = "direct";

  async request(request: TransportRequest): Promise<TransportResponse> {
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        requestId: "exa-release-req",
        searchType: "auto",
        results: [{ id: "https://example.test/from-package", url: "https://example.test/from-package", title: "Packaged", text: "Packaged body" }],
        costDollars: { total: 0.005 },
      }),
      finalUrl: request.url,
    };
  }
}

let home: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "aylens-exa-home-"));
  process.env.AYLENS_HOME = home;
});

afterAll(async () => {
  delete process.env.AYLENS_HOME;
  if (home) await rm(home, { recursive: true, force: true });
});

const poolState = {
  version: 1,
  pools: [{ id: "exa-main", service: "exa", name: "Exa", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "exa-main", name: "primary", secret: "exa-packaged-key", enabled: true, createdAt: 1 },
  ],
  bindings: { exa: "exa-main" },
  state: {},
};

suite("exa standalone provider package", () => {
  it("loads the packaged plugin and declares its capabilities", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());

    expect(loaded.plugins.map((plugin) => plugin.name)).toContain("aylens-exa");
    const factory = loaded.factories.find((candidate) => candidate.type === "exa");
    expect(factory?.capabilities).toEqual(["search", "extract"]);
  });

  it("executes a search without the source workspace on the module path", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === "exa");
    const transports = new TransportRegistry();
    transports.register(new FakeTransport());

    const provider = factory!.create(
      "exa",
      { type: "exa", transport: { primary: "direct", fallback: [] }, options: {} },
      {
        transports,
        credentials: { poolForProvider: () => ({ poolId: "exa-main", pool: new CredentialPool(poolState as never) }) },
      } satisfies ProviderFactoryContext,
    );

    const { items } = await provider.search(
      { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1" },
      { query: "hello" },
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://example.test/from-package");
    expect(items[0]?.provenance.provider).toBe("exa");
    // Key 不得出现在结果里。
    expect(JSON.stringify(items)).not.toContain("exa-packaged-key");
  });

  it("fails closed when no credential service is provided", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === "exa");

    expect(() => factory!.create(
      "exa",
      { type: "exa", options: {} },
      { transports: new TransportRegistry() },
    )).toThrowError(/credential pool/i);
  });
});
