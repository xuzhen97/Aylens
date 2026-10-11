import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRunnerConfig } from "../src/runner/config.js";
import { loadProviderPlugins } from "../src/providers/plugin.js";
import { CredentialPool } from "../src/runner/credentials/pool.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import type { ProviderFactoryContext } from "../src/providers/types.js";

/**
 * 内置 Provider 与**随包发布的 runner.yaml** 的装配守卫。
 *
 * 存在的理由：单测都在自己手搓 factory context，只能证明「Provider 能干活」，
 * 证明不了「配置里声明的 Provider 真的被接上了」。历史上 Tavily 就出现过
 * 代码、单测、配置全都在，实机却恒报 PROVIDER_UNAVAILABLE 的事故。
 *
 * 这里读真实配置文件、按真实 modules 列表装载插件，再真跑一次请求：
 * - yaml 里声明了却没实现的 Provider → 装载不到 factory，直接失败；
 * - transport 名写错 → loadRunnerConfig 的 superRefine 就会拒绝；
 * - 认证头或端点写错 → 假 transport 上断言得到。
 */
const runnerConfig = await loadRunnerConfig(resolve("config/runner.yaml"));

const poolState: CredentialRuntimeState = {
  version: 1,
  pools: [{ id: "exa-main", service: "exa", name: "Exa", enabled: true }],
  credentials: [
    { id: "key-1", poolId: "exa-main", name: "primary", secret: "exa-wiring-secret", enabled: true, createdAt: 1 },
  ],
  bindings: { exa: "exa-main" },
  state: {},
};

class RecordingTransport implements HttpTransport {
  readonly id = "direct";
  readonly calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push({ url: request.url, headers: request.headers });
    return {
      status: 200,
      headers: new Headers(),
      body: JSON.stringify({
        requestId: "wiring-req",
        searchType: "auto",
        results: [{ url: "https://example.test/wired", title: "Wired", text: "body" }],
      }),
    };
  }
}

describe("shipped runner config wiring", () => {
  it("declares a loadable implementation for every configured provider", async () => {
    const loaded = await loadProviderPlugins(runnerConfig.plugins.modules, process.cwd());
    const types = new Set(loaded.factories.map((factory) => factory.type));

    for (const [providerId, deployment] of Object.entries(runnerConfig.providers)) {
      expect(types.has(deployment.type), `no implementation loaded for ${providerId} (${deployment.type})`).toBe(true);
    }
  });

  it("runs the configured exa provider through the real config, transport and credential pool", async () => {
    const deployment = runnerConfig.providers.exa;
    expect(deployment, "config/runner.yaml no longer declares an exa provider").toBeDefined();

    const loaded = await loadProviderPlugins(runnerConfig.plugins.modules, process.cwd());
    const factory = loaded.factories.find((candidate) => candidate.type === deployment!.type);
    expect(factory, "builtin:exa is not registered in src/providers/plugin.ts").toBeDefined();

    const transport = new RecordingTransport();
    const transports = new TransportRegistry();
    transports.register(transport);
    const context: ProviderFactoryContext = {
      transports,
      credentials: { poolForProvider: () => ({ poolId: "exa-main", pool: new CredentialPool(poolState) }) },
    };

    // 用 yaml 里的真实 options / transport 建实例：写错的选项或 transport 名会在这里报错。
    const provider = factory!.create("exa", deployment!, context);
    const { items } = await provider.search(
      { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1" },
      { query: "hello" },
    );

    expect(items).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe("https://api.exa.ai/search");
    expect(transport.calls[0]?.headers?.["x-api-key"]).toBe("exa-wiring-secret");
  });

  it("keeps the paid API providers disabled in the shipped gateway config", async () => {
    const YAML = await import("yaml");
    const { readFile } = await import("node:fs/promises");
    const gateway = YAML.parse(await readFile(resolve("config/aylens.yaml"), "utf8")) as {
      providers?: Record<string, { enabled?: boolean }>;
    };

    // 没配 Key 时不该默认发起付费调用：默认启用等于默认花钱。
    expect(gateway.providers?.tavily?.enabled).toBe(false);
    expect(gateway.providers?.exa?.enabled).toBe(false);
  });
});
