import { describe, expect, it } from "vitest";
import { extractRequestSchema, searchRequestSchema } from "../src/contracts/validation.js";

describe("extract request contract", () => {
  it("requires explicit sources and non-empty urls", () => {
    expect(extractRequestSchema.safeParse({ urls: ["https://a.example"], sources: [] }).success).toBe(false);
    expect(extractRequestSchema.safeParse({ urls: [], sources: ["tavily"] }).success).toBe(false);
    expect(extractRequestSchema.safeParse({ urls: ["https://a.example"], sources: ["tavily"] }).success).toBe(true);
  });

  it("rejects non-http urls and unknown content format", () => {
    expect(extractRequestSchema.safeParse({ urls: ["file:///etc/passwd"], sources: ["tavily"] }).success).toBe(false);
    expect(extractRequestSchema.safeParse({ urls: ["not-a-url"], sources: ["tavily"] }).success).toBe(false);
    expect(extractRequestSchema.safeParse({
      urls: ["https://a.example"], sources: ["tavily"], content: { format: "html" },
    }).success).toBe(false);
  });

  it("keeps existing search requests valid without the new optional fields", () => {
    expect(searchRequestSchema.safeParse({ query: "hello" }).success).toBe(true);
  });

  it("accepts provider-scoped options without leaking them across providers", () => {
    const parsed = searchRequestSchema.parse({
      query: "hello",
      content: { mode: "full", format: "markdown" },
      providerOptions: { tavily: { topic: "news" } },
    });
    expect(parsed.providerOptions?.tavily).toEqual({ topic: "news" });
    expect(parsed.providerOptions?.exa).toBeUndefined();
  });

  it("rejects an invalid search content mode", () => {
    expect(searchRequestSchema.safeParse({ query: "x", content: { mode: "everything" } }).success).toBe(false);
  });
});
