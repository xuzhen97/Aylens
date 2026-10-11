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

const archive = resolve("release/providers/anysearch.aylens-provider");

/**
 * AnySearch 独立 Provider 包的自包含验证。
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
      headers: new Headers({ "content-type": "application/json", "x-request-id": "as-release-req" }),
      body: JSON.stringify({
        code: 0,
        message: "success",
        request_id: "as-release-req",
        data: {
          results: [{ title: "Packaged", url: "https://example.test/from-package", content: "Packaged body" }],
          metadata: { total_results: 1, search_time_ms: 12 },
        },
      }),
      finalUrl: request.url,
    };
  }
}

let home: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "aylens-anysearch-home-"));
  process.env.AYLENS_HOME = home;
});

afterAll(async () => {
  delete process.env.AYLENS_HOME;
  if (home) await rm(home, { recursive: true, force: true });
});

const poolState = {
  version: 1,
  pools: [{ id: "anysearch-main", service: "anysearch", name: "AnySearch", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "anysearch-main", name: "primary", secret: "as-packaged-key", enabled: true, createdAt: 1 },
  ],
  bindings: { anysearch: "anysearch-main" },
  state: {},
};

suite("anysearch standalone provider package", () => {
  it("loads the packaged plugin and declares its capabilities", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());

    expect(loaded.plugins.map((plugin) => plugin.name)).toContain("aylens-anysearch");
    const factory = loaded.factories.find((candidate) => candidate.type === "anysearch");
    expect(factory?.capabilities).toEqual(["search", "extract"]);
  });

  it("executes a search without the source workspace on the module path", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === "anysearch");
    const transports = new TransportRegistry();
    transports.register(new FakeTransport());

    const provider = factory!.create(
      "anysearch",
      { type: "anysearch", transport: { primary: "direct", fallback: [] }, options: {} },
      {
        transports,
        credentials: { poolForProvider: () => ({ poolId: "anysearch-main", pool: new CredentialPool(poolState as never) }) },
      } satisfies ProviderFactoryContext,
    );

    const { items } = await provider.search(
      { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1" },
      { query: "hello" },
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://example.test/from-package");
    expect(items[0]?.provenance.provider).toBe("anysearch");
    // Key 不得出现在结果里。
    expect(JSON.stringify(items)).not.toContain("as-packaged-key");
  });

  it("fails closed when no credential service is provided", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === "anysearch");

    expect(() => factory!.create(
      "anysearch",
      { type: "anysearch", options: {} },
      { transports: new TransportRegistry() },
    )).toThrowError(/credential pool/i);
  });
});
