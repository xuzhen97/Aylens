import { describe, expect, it } from "vitest";
import { ExtractService } from "../src/extract/extract-service.js";
import { InMemoryAuditService } from "../src/audit/audit-service.js";
import { toSafeExtractRequest } from "../src/audit/safe-request.js";
import { ProviderRouter } from "../src/search/router.js";
import { appConfigSchema } from "../src/config/schema.js";
import type { ProviderRouter as ProviderRouterType } from "../src/search/router.js";

function routerWith(...providerIds: string[]): ProviderRouterType {
  const config = appConfigSchema.parse({
    version: 1,
    auth: { apiKey: "test-key" },
    providers: Object.fromEntries(providerIds.map((id) => [id, { type: "demo" }])),
    routes: { default: { providers: providerIds } },
  });
  return new ProviderRouter(config);
}

function harness(
  outputs: Record<string, unknown[]>,
  failures: Record<string, Error> = {},
  router: ProviderRouterType = { resolveExplicit: (sources: string[]) => sources } as ProviderRouterType,
) {
  const audit = new InMemoryAuditService();
  const calls: Array<{ providerId: string }> = [];
  const dispatcher = {
    extract: async (providerId: string) => {
      calls.push({ providerId });
      const failure = failures[providerId];
      if (failure) throw failure;
      return { runtimeId: "runner-1", output: { items: outputs[providerId] ?? [] } };
    },
  } as never;
  const service = new ExtractService(router, dispatcher, audit);
  return { service, audit, calls };
}

const offlineError = Object.assign(new Error("Runtime is not connected: dev-runner"), {
  code: "RUNTIME_OFFLINE",
  retryable: true,
});

describe("ExtractService", () => {
  it("reports partial when one provider fails", async () => {
    const { service } = harness(
      { tavily: [{ index: 0, url: "https://a.example", status: "success" }] },
      { exa: offlineError },
    );

    const result = await service.extract({ urls: ["https://a.example"], sources: ["tavily", "exa"] });

    expect(result.status).toBe("partial");
    expect(result.meta.providers.exa?.status).toBe("failed");
    expect(result.meta.providers.tavily?.status).toBe("success");
    expect(result.items).toHaveLength(1);
  });

  it("never reports completed when every item failed", async () => {
    const { service } = harness({
      tavily: [{
        index: 0,
        url: "https://a.example",
        status: "failed",
        error: { code: "CONTENT_UNAVAILABLE", message: "no content", retryable: false },
      }],
    });

    const result = await service.extract({ urls: ["https://a.example"], sources: ["tavily"] });

    expect(result.status).toBe("failed");
  });

  it("stays partial when items exist but a provider produced no items", async () => {
    const { service } = harness({
      tavily: [{ index: 0, url: "https://a.example", status: "success" }],
      exa: [],
    });

    const result = await service.extract({ urls: ["https://a.example"], sources: ["tavily", "exa"] });

    // 有成功也有失败(零项 provider 计为异常) → 不能标 completed。
    expect(result.status).toBe("partial");
  });

  it("does not dispatch when audit start fails", async () => {
    const audit = new InMemoryAuditService();
    audit.start = () => {
      throw new Error("audit down");
    };
    let dispatched = 0;
    const dispatcher = {
      extract: async () => {
        dispatched += 1;
        return { runtimeId: "r", output: { items: [] } };
      },
    } as never;
    const service = new ExtractService(
      { resolveExplicit: (s: string[]) => s } as unknown as ProviderRouterType,
      dispatcher,
      audit,
    );

    await expect(service.extract({ urls: ["https://a.example"], sources: ["tavily"] }))
      .rejects.toMatchObject({ code: "AUDIT_STORAGE_FAILED" });
    expect(dispatched).toBe(0);
  });

  it("rejects unknown providers before dispatching", async () => {
    const { service, calls } = harness({}, {}, routerWith("tavily"));

    await expect(service.extract({ urls: ["https://a.example"], sources: ["ghost"] }))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });

  it("records the request as an extract operation in the audit log", async () => {
    const { service, audit } = harness({ tavily: [] });
    const result = await service.extract({ urls: ["https://a.example"], sources: ["tavily"] });

    const record = audit.get(result.requestId);
    expect(record?.operation).toBe("extract");
    expect(record?.status).toBe("failed");
  });

  it("synthesizes an explicit failure for URLs no provider covered", async () => {
    const { service } = harness(
      { tavily: [{ index: 1, url: "https://b.example", status: "success" }] },
      { exa: offlineError },
    );

    const result = await service.extract({
      urls: ["https://a.example", "https://b.example"],
      sources: ["tavily", "exa"],
    });

    // urls 与 items 必须一一对应：任何输入都不能静默消失。
    expect(result.items.map((item) => item.index)).toEqual([0, 1]);
    expect(result.items[0]).toMatchObject({
      index: 0,
      url: "https://a.example",
      status: "failed",
      error: { code: "RUNTIME_OFFLINE", message: expect.any(String), retryable: true },
    });
    // 固定本地文案，不回传上游或原始 Error 的 message。
    expect(result.items[0]?.error?.message).not.toContain("Runtime is not connected");
    expect(result.status).toBe("partial");
  });

  it("drops provider items whose index falls outside the request", async () => {
    const { service } = harness({
      tavily: [
        { index: 0, url: "https://a.example", status: "success" },
        { index: 7, url: "https://unexpected.example", status: "success" },
      ],
    });

    const result = await service.extract({ urls: ["https://a.example"], sources: ["tavily"] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.index).toBe(0);
  });

  it("sorts items back to input order regardless of provider response order", async () => {
    const { service } = harness({
      tavily: [
        { index: 1, url: "https://b.example", status: "success" },
        { index: 0, url: "https://a.example", status: "success" },
      ],
    });

    const result = await service.extract({
      urls: ["https://a.example", "https://b.example"],
      sources: ["tavily"],
    });

    expect(result.items.map((item) => item.index)).toEqual([0, 1]);
    expect(result.items.map((item) => item.url)).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("toSafeExtractRequest", () => {
  it("strips query, fragment and userinfo from every url", () => {
    const safe = toSafeExtractRequest({
      urls: [
        "https://user:pass@example.com/a?token=secret#frag",
        "https://second.example/b?api_key=hidden",
      ],
      sources: ["tavily"],
    });

    expect(safe.query).not.toContain("secret");
    expect(safe.query).not.toContain("hidden");
    expect(safe.query).not.toContain("user:pass");
    expect(safe.query).not.toContain("#frag");
    expect(safe.query).toContain("https://example.com/a");
    expect(safe.query).toContain("https://second.example/b");
    expect(safe.sources).toEqual(["tavily"]);
  });

  it("truncates to the same 500 char budget as search summaries", () => {
    const many = Array.from({ length: 40 }, (_, index) => `https://example.com/${"x".repeat(40)}${index}`);
    const safe = toSafeExtractRequest({ urls: many, sources: ["tavily"] });
    expect(safe.query.length).toBeLessThanOrEqual(500);
  });

  it("keeps plain search summaries unchanged", async () => {
    // 回归：既有 search 审计的脱敏行为不受 extract 摘要影响。
    const audit = new InMemoryAuditService();
    audit.start("r1", "t1", { query: "https://example.com/p?q=secret" });
    expect(audit.get("r1")?.request.query).toBe("https://example.com/p");
    expect(audit.get("r1")?.operation).toBeUndefined();
  });
});
