import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { loadRunnerStartup, type RunnerStartup } from "../src/runner/config.js";
import { createRunnerRuntime, type RunnerRuntime } from "../src/runner/runtime.js";
import { openSqlite } from "../src/storage/sqlite.js";
import { runnerMigrations } from "../src/storage/runner-migrations.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "../src/transports/types.js";
import type { ProviderContext } from "../src/providers/types.js";

/**
 * API-only Runner：不配置任何浏览器 Profile、不启动 Chrome，
 * 也要能装载凭据服务、上报能力并执行 Tavily 检索。
 *
 * 这是“真实启动入口装配”的回归测试：历史上出现过功能代码与单测都在，
 * 但真实入口漏传服务、导致能力恒为 false 的事故。
 */
let dir: string;
let database: DatabaseSync;
let startup: RunnerStartup | undefined;
let runtime: RunnerRuntime | undefined;

const ctx: ProviderContext = { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1", jobId: "job-1" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aylens-api-only-"));
  database = openSqlite(join(dir, "runner.db"), runnerMigrations);
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  startup?.close();
  startup = undefined;
  // startup.close() 可能已关闭注入的数据库（它们是同一个句柄）。
  try {
    database.close();
  } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(extra: Record<string, unknown>): Promise<string> {
  const path = join(dir, "runner.yaml");
  await writeFile(path, JSON.stringify({
    runner: { id: "api-only", gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect", token: "t" },
    plugins: { modules: ["builtin:tavily"] },
    // 关键：没有 browser 段、没有 browserProfiles —— API-only 部署。
    transports: {},
    providers: {},
    ...extra,
  }), "utf8");
  return path;
}

function fakeTransport(respond: () => { status: number; body: string }): HttpTransport {
  return {
    id: "direct",
    request: async (_request: TransportRequest): Promise<TransportResponse> => {
      const result = respond();
      return { status: result.status, headers: new Headers(), body: result.body };
    },
  };
}

describe("API-only runner", () => {
  it("starts without any browser profile and wires the credential service", async () => {
    const path = await writeConfig({});
    startup = await loadRunnerStartup(path, { database, databasePath: join(dir, "runner.db") });

    // 装配：凭据服务必须由真实启动入口注入，否则管理能力恒为 false。
    expect(startup.credentialService).toBeDefined();

    runtime = await createRunnerRuntime(startup.config, {
      proxyConfig: startup.service,
      credentials: startup.credentialService,
    });

    expect(runtime.credentials).toBe(startup.credentialService);
    // 无浏览器部署的可观察证据：没有注册任何 Profile，因此能力上报 browserAutomation=false。
    expect(runtime.profiles.list()).toEqual([]);
  });

  it("executes a Tavily search end to end without a browser", async () => {
    const path = await writeConfig({
      // 不声明 transport：Tavily 默认取 "direct"，由测试在 runtime 的注册表里注入假传输。
      // 这样既不触发“Unknown Runner-local transport”校验，也用的是真实装配路径。
      providers: {
        tavily: { type: "tavily", options: {} },
      },
    });
    startup = await loadRunnerStartup(path, { database, databasePath: join(dir, "runner.db") });

    // Provider 绑定到本地池，无浏览器依赖。
    startup.credentialService.write({
      operationId: "op-1",
      expectedVersion: 0,
      mutation: { kind: "put-pool", id: "tavily-main", service: "tavily", name: "Tavily", enabled: true },
    });
    startup.credentialService.write({
      operationId: "op-2",
      expectedVersion: 1,
      mutation: {
        kind: "put-credential",
        id: "key-1",
        poolId: "tavily-main",
        name: "primary",
        secret: "tvly-api-only-key",
        enabled: true,
      },
    });
    startup.credentialService.write({
      operationId: "op-3",
      expectedVersion: 2,
      mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" },
    });

    runtime = await createRunnerRuntime(startup.config, {
      proxyConfig: startup.service,
      credentials: startup.credentialService,
    });
    // API-only：假传输只注入给 Provider 上下文，不碰 runtime 已装配的注册表
    // （proxy store 会无条件内置 direct，runtime 侧已注册，无法重复注册）。
    // 全程不触碰 BrowserHost。
    const providerTransports = new TransportRegistry();
    providerTransports.register(fakeTransport(() => ({
      status: 200,
      body: JSON.stringify({
        request_id: "tvly-api-only",
        response_time: 0.3,
        results: [{ url: "https://a.example", title: "A", content: "Snippet", score: 0.8 }],
      }),
    })));

    const provider = runtime.providers.create(
      "tavily",
      startup.config.providers.tavily!,
      {
        transports: providerTransports,
        browser: runtime.browser,
        credentials: {
          poolForProvider: (providerId: string) => {
            const bound = runtime!.credentialPool(providerId);
            return bound;
          },
        },
      },
    );

    const { items } = await provider.search(ctx, { query: "api only" });

    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://a.example");
    expect(items[0]?.provenance.provider).toBe("tavily");
    expect(items[0]?.provenance.runtimeId).toBe("runner-1");
  });
});
