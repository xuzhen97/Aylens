import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SearchResults } from "./search-results";

const response = {
  requestId: "request-1", traceId: "trace-1", status: "partial" as const,
  items: [{
    id: "item-1", platform: "web", type: "page", url: "javascript:alert(1)", title: "<script>unsafe</script>",
    text: "<img src=x onerror=alert(1)>", retrievedAt: "2026-01-01T00:00:00Z",
    provenance: { provider: "p", retrievalMethod: "browser", requestId: "request-1", fetchedAt: "2026-01-01T00:00:00Z" },
  }],
  meta: { providers: { failedProvider: {
    status: "failed" as const, runtimeId: "runner-1", latencyMs: 25, resultCount: 0,
    error: { code: "UPSTREAM_ERROR", message: "failed safely", retryable: true },
  } } },
};

describe("SearchResults", () => {
  it("renders untrusted content as text and reports provider failures", () => {
    const { container } = render(<SearchResults response={response} />);
    expect(screen.getByText("UPSTREAM_ERROR")).toBeVisible();
    expect(screen.getByText("<script>unsafe</script>")).toBeVisible();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(container.querySelector("script, img, a[href^='javascript:']")).toBeNull();
  });
});
