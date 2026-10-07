import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../src/config/schema.js";

describe("Admin HTTP origin configuration", () => {
  const config = (server: Record<string, unknown>) => appConfigSchema.parse({
    version: 1,
    server,
    auth: { apiKey: "test-key" },
  });

  it("defaults to no trusted proxies and normalizes a public origin", () => {
    expect(config({}).server.trustProxy).toEqual([]);
    expect(config({ publicOrigin: "https://admin.example.test/" }).server.publicOrigin)
      .toBe("https://admin.example.test");
  });

  it.each([
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test/?x=1",
    "ftp://example.test",
  ])("rejects unsafe public origin %s", (publicOrigin) => {
    expect(() => config({ publicOrigin })).toThrow();
  });

  it("accepts explicit IP/CIDR proxy entries and rejects hostnames and wildcards", () => {
    expect(config({ trustProxy: ["127.0.0.1", "10.0.0.0/8", "::1/128"] }).server.trustProxy)
      .toEqual(["127.0.0.1", "10.0.0.0/8", "::1/128"]);
    expect(() => config({ trustProxy: ["*"] })).toThrow();
    expect(() => config({ trustProxy: ["proxy.internal"] })).toThrow();
    expect(() => config({ trustProxy: ["10.0.0.0/99"] })).toThrow();
  });
});
