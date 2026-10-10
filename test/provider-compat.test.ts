import { describe, expect, it } from "vitest";
import { ExtractService } from "../src/extract/extract-service.js";
import { InMemoryAuditService } from "../src/audit/audit-service.js";
import { CredentialPool } from "../src/runner/credentials/pool.js";
import { TransportRegistry } from "../src/transports/registry.js";
import type { CredentialRuntimeState } from "../src/runner/credentials/types.js";
import type { ProviderContext } from "../src/providers/types.js";
import type { ProviderRouter } from "../src/search/router.js";
import { ConcurrencyTrackingTransport, createVendorDouble } from "./helpers/vendor-double.js";

/**
 * 兼容性证明：公共层必须能承接**形状不同**的服务商，而不是把 Tavily 的形状当前提。
 *
 * 这里用测试替身覆盖两种真实差异（Spec §10）：
 * - Exa 形状：原生批次上限远大于 Tavily（100），且 Team 级限流；
 * - AnySearch 形状：每次只取一个 URL（须自行有界并发），且 HTTP 200 也可能是业务失败。
 */

const providerCtx: ProviderContext = { requestId: "req-1", traceId: "trace-1", runtimeId: "runner-1", jobId: "job-1" };

function poolState(service: string, count = 2): CredentialRuntimeState {
  return {
    version: 1,
    pools: [{ id: `${service}-main`, service, name: service, enabled: true }],
    credentials: Array.from({ length: count }, (_, index) => ({
      id: `k${index + 1}`,
      poolId: `${service}-main`,
      name: `k${index + 1}`,
      secret: `${service}-secret-${index + 1}`,
      enabled: true,
      accountGroup: `${service}-team`,
      createdAt: index,
    })),
    bindings: { [service]: `${service}-main` },
    state: {},
  };
}

function harness(
  service: string,
  options: { nativeBatchSize: number; bodyCodeMode?: boolean; maxConcurrentExtracts?: number },
  respond: (request: { path: string; urls: string[] }) => { status: number; body: string },
  state: CredentialRuntimeState = poolState(service),
) {
  const transport = new ConcurrencyTrackingTransport(respond);
  const transports = new TransportRegistry();
  transports.register(transport);

  const pool = new CredentialPool(state);
  const credentials = { poolForProvider: () => ({ poolId: `${service}-main`, pool }) };
  const provider = createVendorDouble(service, { ...options, credentials, transports });

  const audit = new InMemoryAuditService();
  const dispatcher = {
    extract: async (_providerId: string, request: never) => ({
      runtimeId: "runner-1",
      output: await provider.extract(providerCtx, request),
    }),
  } as never;

  const service_ = new ExtractService(
    { resolveExplicit: (sources: string[]) => sources } as unknown as ProviderRouter,
    dispatcher,
    audit,
  );
  return { service: service_, transport, pool, provider };
}

describe("vendor shape compatibility", () => {
  it("handles a provider whose native extract batch is far larger than Tavily's (Exa shape)", async () => {
    const urls = Array.from({ length: 100 }, (_, index) => `https://example.com/${index}`);
    const { service, transport } = harness(
      "exa",
      { nativeBatchSize: 100 },
      ({ urls: batch }) => ({
        status: 200,
        body: JSON.stringify({
          results: batch.map((url) => ({ url, raw_content: `body for ${url}` })),
        }),
      }),
    );

    const result = await service.extract({ urls, sources: ["exa"] });

    // 100 个 URL 只需一次上游调用：批次上限由适配器决定，公共层不设更低的天花板。
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.urls).toHaveLength(100);
    expect(result.status).toBe("completed");
    expect(result.items).toHaveLength(100);
    expect(result.items[99]).toMatchObject({ index: 99, url: urls[99], status: "success" });
  });

  it("handles a single-URL provider with bounded concurrency (AnySearch shape)", async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`);
    const { service, transport } = harness(
      "anysearch",
      { nativeBatchSize: 1, maxConcurrentExtracts: 2 },
      ({ urls: batch }) => ({
        status: 200,
        body: JSON.stringify({
          code: 0,
          message: "success",
          results: batch.map((url) => ({ url, raw_content: `body for ${url}` })),
        }),
      }),
    );

    const result = await service.extract({ urls, sources: ["anysearch"] });

    // 每个 URL 一次调用，但并发被适配器限制在 2。
    expect(transport.calls).toHaveLength(6);
    expect(transport.calls.every((call) => call.urls.length === 1)).toBe(true);
    expect(transport.maxObservedConcurrency).toBeLessThanOrEqual(2);
    expect(result.status).toBe("completed");
    expect(result.items.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("treats an HTTP 200 body-code failure as a failure, not a success (AnySearch shape)", async () => {
    const { service, pool } = harness(
      "anysearch",
      { nativeBatchSize: 1, bodyCodeMode: true },
      () => ({
        status: 200,
        // HTTP 层成功，业务层失败：只看状态码的实现会把它当成成功。
        body: JSON.stringify({ code: -1, message: "quota exhausted", error_code: "rate_limit_exceeded_user" }),
      }),
    );

    const result = await service.extract({ urls: ["https://example.com/a"], sources: ["anysearch"] });

    expect(result.status).toBe("failed");
    expect(result.items[0]).toMatchObject({ status: "failed" });
    // 业务失败必须落到凭据池，而不是被当成成功把 Key 一直用下去。
    expect(pool.availability("k1")).toBe("quota_blocked");
    expect(pool.availability("k2")).toBe("quota_blocked");
    expect(pool.tryAcquire("anysearch-main")).toBeUndefined();
  });

  it("keeps a provider that reports results out of order aligned by input index", async () => {
    const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
    const { service } = harness(
      "exa",
      { nativeBatchSize: 3 },
      ({ urls: batch }) => ({
        status: 200,
        body: JSON.stringify({
          // 故意打乱顺序，并在中间漏掉一个 URL。
          results: [
            { url: batch[2], raw_content: "C" },
            { url: batch[0], raw_content: "A" },
          ],
        }),
      }),
    );

    const result = await service.extract({ urls, sources: ["exa"] });

    expect(result.items.map((item) => [item.index, item.status])).toEqual([
      [0, "success"],
      [1, "failed"],
      [2, "success"],
    ]);
    expect(result.status).toBe("partial");
  });
});
