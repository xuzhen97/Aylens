import { describe, expect, it } from "vitest";

import { RetrievalError } from "../src/core/errors.js";
import { extractContent } from "../src/providers/url-fetch/extract.js";
import { parseOptions } from "../src/providers/url-fetch/options.js";
import { readFixture } from "./helpers/url-fetch-extraction.js";

const options = parseOptions({});
const pageUrl = "https://example.com/blog/fenced-code";

describe("extractContent for HTML", () => {
  it("keeps code, resolves relative links and drops navigation noise", async () => {
    const result = extractContent(await readFixture("article.html"), pageUrl, "html", options);

    expect(result.markdown).toContain("```ts");
    expect(result.markdown).toContain("const a = 1;\n  const b = 2;");
    expect(result.markdown).toContain("https://example.com/help");
    expect(result.markdown).not.toContain("Nav A");
    expect(result.markdown).not.toContain("Footer junk");
    expect(result.markdown).not.toContain("Related posts");
    expect(result.canonicalUrl).toBe("https://example.com/blog/fenced-code");
    // 纯文本派生不能把围栏带进去。
    expect(result.text).not.toContain("```");
    expect(result.text).toContain("Understanding Fenced Code");
  });

  it("keeps GFM tables and nested list structure", async () => {
    const result = extractContent(await readFixture("article.html"), pageUrl, "html", options);

    expect(result.markdown).toMatch(/\|\s*Mode\s*\|\s*Keeps structure\s*\|/);
    expect(result.markdown).toMatch(/-\s*\| -+ \|/);
    expect(result.markdown).toMatch(/1\.\s+Open the editor/);
    expect(result.markdown).toMatch(/-\s+Choose a language/);
  });

  it("fences a bare pre element instead of degrading it to a paragraph", () => {
    const html = "<main><h1>API</h1><pre>x = 1\n  y = 2</pre><p>Text after the sample.</p></main>";
    const result = extractContent(html, pageUrl, "html", options);

    expect(result.markdown).toContain("```");
    expect(result.markdown).toContain("x = 1\n  y = 2");
  });

  it("uses a fence longer than the longest backtick run inside the code", () => {
    const html = "<main><pre><code>a ``` b</code></pre><p>Context text.</p></main>";
    const result = extractContent(html, pageUrl, "html", options);

    expect(result.markdown).toContain("````");
  });

  it("honours an existing base element", () => {
    const html = '<html><head><base href="https://cdn.example.com/docs/"></head><body><main><p><a href="intro">Intro</a></p></main></body></html>';
    const result = extractContent(html, pageUrl, "html", options);

    expect(result.markdown).toContain("https://cdn.example.com/docs/intro");
  });

  it("does not carry dangerous link schemes into the markdown", () => {
    const html = '<main><p><a href="javascript:alert(1)">click me</a></p></main>';
    const markdown = extractContent(html, pageUrl, "html", options).markdown;

    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("click me");
  });

  it("uses Readability for article mode and the whole body for full mode", async () => {
    const article = await readFixture("article.html");
    const docs = await readFixture("docs.html");

    expect(extractContent(article, pageUrl, "html", parseOptions({ contentMode: "article" })).extractionMethod)
      .toBe("readability");

    const full = extractContent(docs, "https://example.com/docs/api", "html", parseOptions({ contentMode: "full" }));
    expect(full.extractionMethod).toBe("body");
    expect(full.markdown).toContain("Release notes outside the main container");

    const auto = extractContent(docs, "https://example.com/docs/api", "html", options);
    expect(["readability", "semantic"]).toContain(auto.extractionMethod);
    expect(auto.markdown).toMatch(/\|\s*Field\s*\|\s*Meaning\s*\|/);
    expect(auto.markdown).toContain("url-fetch");
  });

  it("fails clearly when contentSelector is missing or invalid", () => {
    const html = "<main><table><tr><td>cell</td></tr></table></main>";

    const selected = extractContent(html, pageUrl, "html", parseOptions({ contentSelector: "table" }));
    expect(selected.extractionMethod).toBe("selector");
    expect(selected.markdown).toContain("cell");

    expect(() => extractContent(html, pageUrl, "html", parseOptions({ contentSelector: "table#missing" })))
      .toThrowError(RetrievalError);
    expect(() => extractContent(html, pageUrl, "html", parseOptions({ contentSelector: "div[" })))
      .toThrowError(RetrievalError);
  });

  it("stops processing when the document exceeds the element budget", () => {
    const html = `<main>${"<p>x</p>".repeat(150)}</main>`;

    expect(() => extractContent(html, pageUrl, "html", parseOptions({ maxDomElements: 100 })))
      .toThrowError(RetrievalError);
  });

  it("truncates on a block boundary and closes the fenced block", () => {
    const html = `<main><pre><code>${"line of code\n".repeat(400)}</code></pre>${"<p>tail</p>".repeat(50)}</main>`;
    const result = extractContent(html, pageUrl, "html", parseOptions({ maxMarkdownChars: 2_000 }));

    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(2_000);
    const fences = result.markdown.match(/^```/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});

describe("extractContent for native markdown", () => {
  const markdown = [
    "# Title",
    "",
    "<script>alert(1)</script>",
    "",
    "See [x](javascript:alert(1)) and `inline code`.",
    "",
    "```",
    "<div>keep me</div>",
    "```",
    "",
  ].join("\n");

  it("drops raw HTML blocks, neutralizes dangerous links and keeps code content", () => {
    const result = extractContent(markdown, pageUrl, "markdown", options);

    expect(result.markdown).not.toContain("<script>");
    expect(result.markdown).not.toContain("javascript:alert");
    // 行内代码与围栏内的内容都不是 html_block，不能被误删。
    expect(result.markdown).toContain("<div>keep me</div>");
    expect(result.markdown).toContain("`inline code`");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("derives plain text without markdown markers", () => {
    const result = extractContent(markdown, pageUrl, "markdown", options);

    expect(result.text).toContain("Title");
    expect(result.text).toContain("<div>keep me</div>");
    expect(result.text).not.toContain("```");
    expect(result.text).not.toContain("](javascript");
  });
});

describe("extractContent for plain text", () => {
  it("passes text through without parsing it as markup", () => {
    const result = extractContent("<b>not markup</b>", pageUrl, "text", options);

    expect(result.markdown).toContain("<b>not markup</b>");
    expect(result.text).toContain("<b>not markup</b>");
  });
});

describe("parseOptions", () => {
  it("rejects unknown keys, wrong types and out-of-range values", () => {
    expect(() => parseOptions({ maxResponseBytesTypo: 10 })).toThrowError(RetrievalError);
    expect(() => parseOptions({ timeoutMs: "soon" })).toThrowError(RetrievalError);
    expect(() => parseOptions({ timeoutMs: 10 })).toThrowError(RetrievalError);
    expect(() => parseOptions({ contentMode: "everything" })).toThrowError(RetrievalError);
    expect(() => parseOptions({ browserFallback: "yes" })).toThrowError(RetrievalError);
    expect(() => parseOptions({ contentSelector: "   " })).toThrowError(RetrievalError);
  });

  it("keeps the documented defaults", () => {
    const parsed = parseOptions({});

    expect(parsed.timeoutMs).toBe(25_000);
    expect(parsed.httpTimeoutMs).toBe(8_000);
    expect(parsed.contentMode).toBe("auto");
    expect(parsed.browserFallback).toBe(true);
    expect(parsed.fallbackOnHttpTimeout).toBe(false);
    // 出口声明默认必须是 false：没有确认过的出口就不该放行代理/浏览器兜底。
    expect(parsed.controlledProxyEgress).toBe(false);
    expect(parsed.controlledBrowserEgress).toBe(false);
  });
});
