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

const archive = resolve("release/providers/tavily.aylens-provider");

/**
 * Tavily 独立 Provider 包的自包含验证。
 *
 * 包会解到**源码目录之外**加载：Node 无法向上解析到仓库的 node_modules，
 * 任何未被打进包的运行时依赖都会在这里以 MODULE_NOT_FOUND 暴露。
 * 这也是本文件存在的理由——Tavily 链路跨了 api-client、providers、core 多个目录。
 */
const suite = existsSync(archive) ? describe : describe.skip;

class FakeTransport implements HttpTransport {
  readonly id = "direct";

  async request(request: TransportRequest): Promise<TransportResponse> {
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json", "x-request-id": "tvly-release-req" }),
      body: JSON.stringify({
        request_id: "tvly-release-req",
        response_time: 0.4,
        results: [{ url: "https://example.test/from-package", title: "Packaged", content: "Snippet" }],
      }),
      finalUrl: request.url,
    };
  }
}

let home: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "aylens-tavily-home-"));
  process.env.AYLENS_HOME = home;
});

afterAll(async () => {
  delete process.env.AYLENS_HOME;
  if (home) await rm(home, { recursive: true, force: true });
});

const poolState = {
  version: 1,
  pools: [{ id: "tavily-main", service: "tavily", name: "Tavily", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "tavily-main", name: "primary", secret: "tvly-packaged-key", enabled: true, createdAt: 1 },
  ],
  bindings: { tavily: "tavily-main" },
  state: {},
};

suite("tavily standalone provider package", () => {
  it("loads from outside the source tree and declares search + extract", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());

    expect(loaded.plugins.map((plugin) => plugin.name)).toContain("aylens-tavily");
    const factory = loaded.factories.find((candidate) => candidate.type === "tavily");
    expect(factory).toBeDefined();
    expect(factory?.capabilities).toEqual(["search", "extract", "usage"]);
  });

  it("executes a search without any browser capability", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === "tavily");
    expect(factory).toBeDefined();

    const registry = new TransportRegistry();
    registry.registerFactory({ type: "direct", create: () => new FakeTransport() });
    registry.build("direct", { type: "direct" });

    const services: ProviderFactoryContext = {
      transports: registry,
      // 没有 browser —— API-only Runner 必须能跑。
      credentials: {
        poolForProvider: () => ({ poolId: "tavily-main", pool: new CredentialPool(poolState as never) }),
      },
    };

    const provider = factory!.create(
      "tavily",
      { type: "tavily", transport: { primary: "direct", fallback: [] }, options: {} },
      services,
    );

    const { items } = await provider.search(
      { requestId: "req-release", traceId: "trace-release", runtimeId: "runner-release" },
      { query: "package self-contained" },
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://example.test/from-package");
    expect(items[0]?.provenance.provider).toBe("tavily");
    // Key 不得出现在结果里。
    expect(JSON.stringify(items)).not.toContain("tvly-packaged-key");
  });

  it("fails closed when no credential service is provided", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === "tavily");

    expect(() => factory!.create(
      "tavily",
      { type: "tavily", options: {} },
      { transports: new TransportRegistry() },
    )).toThrowError(/credential pool/i);
  });
});
