import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadProviderPlugins } from "../src/providers/plugin.js";
import type { ProviderFactoryContext } from "../src/providers/types.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import { TransportRegistry } from "../src/transports/registry.js";

const archive = resolve("release/providers/url-fetch.aylens-provider");

/**
 * 独立 Provider 包的自包含验证。
 *
 * 这是 Task 1 存在的理由：把包解到**源码目录之外**再加载，Node 无法向上解析到仓库的
 * node_modules，因此任何未被打进包的依赖都会在这里以 MODULE_NOT_FOUND 暴露出来。
 */
const suite = existsSync(archive) ? describe : describe.skip;

class FakeTransport implements HttpTransport {
  readonly id = "direct";

  async request(request: TransportRequest): Promise<TransportResponse> {
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      body: [
        "<!doctype html><html><head><title>Packaged</title></head><body>",
        '<nav><a href="/x">nav noise</a></nav>',
        "<main><h1>Packaged provider</h1><p>Rendered from the standalone package.</p>",
        "<pre><code>const a = 1;\n  const b = 2;</code></pre></main></body></html>",
      ].join(""),
      finalUrl: request.url,
    };
  }
}

let home: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "aylens-provider-home-"));
  process.env.AYLENS_HOME = home;
});

afterAll(async () => {
  delete process.env.AYLENS_HOME;
  if (home) await rm(home, { recursive: true, force: true });
});

suite("url-fetch standalone provider package", () => {
  it("loads from outside the source tree and produces markdown", async () => {
    const loaded = await loadProviderPlugins([archive], process.cwd());

    expect(loaded.plugins.map((plugin) => plugin.name)).toContain("aylens-url-fetch");
    const factory = loaded.factories.find((candidate) => candidate.type === "url-fetch");
    expect(factory).toBeDefined();

    const transport = new FakeTransport();
    const registry = new TransportRegistry();
    registry.registerFactory({ type: "direct", create: () => transport });
    registry.build("direct", { type: "direct" });

    const services: ProviderFactoryContext = {
      transports: registry,
      defaultBrowserProfile: "browser-main",
    };

    const provider = factory!.create("url-fetch", { type: "url-fetch", options: {} }, services);
    const result = await provider.search(
      { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1", jobId: "job-1" },
      { query: "https://example.com/packaged" },
    );

    expect(result.items[0]?.markdown).toContain("# Packaged provider");
    expect(result.items[0]?.markdown).toContain("```");
    expect(result.items[0]?.markdown).toContain("  const b = 2;");
    expect(result.items[0]?.markdown).not.toContain("nav noise");
    expect(result.items[0]?.text).not.toContain("```");
  });

  it("extracts the package outside the repository so repo node_modules cannot help", async () => {
    // 包被解到 AYLENS_HOME 下的内容寻址缓存；这里断言它确实不在仓库内，
    // 否则上面的加载测试会因为能借到仓库依赖而失去意义。
    const homeDir = home ?? "";
    expect(homeDir).not.toBe("");

    // 跨盘符时 relative() 返回绝对路径而不是 ".." 开头，两种情况都算“在仓库之外”。
    const rel = relative(resolve("."), homeDir);
    expect(rel.startsWith("..") || isAbsolute(rel)).toBe(true);
  });
});
