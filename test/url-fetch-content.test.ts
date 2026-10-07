import { describe, expect, it } from "vitest";

import { classifyContent } from "../src/providers/url-fetch/content.js";
import { readFixture } from "./helpers/url-fetch-extraction.js";

const LONG_ARTICLE = `<html><head><title>All about verification widgets</title></head><body><main>
<h1>Verification widgets</h1>
<p>${"This article integrates g-recaptcha in a demo form and explains how the widget behaves. ".repeat(12)}</p>
<form><input name="demo"></form>
</main></body></html>`;

describe("classifyContent statuses", () => {
  it("rejects the statuses that must never become a browser attempt", () => {
    expect(classifyContent(404, "text/html", "")).toEqual({ kind: "reject", code: "CONTENT_UNAVAILABLE" });
    expect(classifyContent(410, "text/html", "")).toEqual({ kind: "reject", code: "CONTENT_UNAVAILABLE" });
    expect(classifyContent(429, "text/html", "")).toEqual({ kind: "reject", code: "RATE_LIMITED" });
    expect(classifyContent(500, "text/html", "")).toEqual({ kind: "reject", code: "UPSTREAM_ERROR" });
    expect(classifyContent(503, "text/html", "")).toEqual({ kind: "reject", code: "UPSTREAM_ERROR" });
    // 未被重定向循环消化的 3xx 属于异常，不是"需要浏览器"。
    expect(classifyContent(302, "text/html", "")).toEqual({ kind: "reject", code: "UPSTREAM_ERROR" });
  });

  it("allows a session fallback for authentication statuses", () => {
    expect(classifyContent(401, "text/html", "")).toEqual({ kind: "browser", reason: "auth-required" });
    expect(classifyContent(403, "text/html", "")).toEqual({ kind: "browser", reason: "auth-required" });
  });
});

describe("classifyContent formats", () => {
  it("recognises native markdown, html and plain text", () => {
    expect(classifyContent(200, "text/markdown; charset=utf-8", "# T")).toEqual({ kind: "usable", format: "markdown" });
    expect(classifyContent(200, "text/plain", "just text")).toEqual({ kind: "usable", format: "text" });
    expect(classifyContent(
      200,
      "text/html; charset=utf-8",
      "<html><body><p>A page with a reasonably long body so it is not treated as an empty shell.</p></body></html>",
    )).toEqual({ kind: "usable", format: "html" });
  });

  it("sniffs the format when the content type is missing", () => {
    expect(classifyContent(200, null, "<!doctype html><html><body>x</body></html>"))
      .toEqual({ kind: "usable", format: "html" });
    expect(classifyContent(200, null, "plain text body")).toEqual({ kind: "usable", format: "text" });
  });

  it("rejects payload types it cannot read instead of handing them to the browser", () => {
    for (const mime of ["application/pdf", "image/png", "video/mp4", "application/octet-stream", "application/zip"]) {
      expect(classifyContent(200, mime, "x")).toEqual({ kind: "reject", code: "CONTENT_UNAVAILABLE" });
    }
  });
});

describe("classifyContent browser fallback signals", () => {
  it("keeps a short page usable when it has no script", () => {
    expect(classifyContent(200, "text/html", "<html><body><p>hi</p></body></html>"))
      .toEqual({ kind: "usable", format: "html" });
  });

  it("treats an empty application root with a script as a JS shell", async () => {
    expect(classifyContent(200, "text/html", await readFixture("js-shell.html")))
      .toEqual({ kind: "browser", reason: "js-shell" });
  });

  it("detects an explicit JavaScript requirement from noscript", () => {
    const html = "<html><head><title>App</title></head><body><noscript>Please enable JavaScript to continue using this application.</noscript></body></html>";
    expect(classifyContent(200, "text/html", html)).toEqual({ kind: "browser", reason: "js-required" });
  });

  it("detects a login page through its password form", async () => {
    expect(classifyContent(200, "text/html", await readFixture("login.html")))
      .toEqual({ kind: "browser", reason: "auth-required" });
  });

  it("detects an interstitial challenge page", () => {
    const html = '<html><head><title>Just a moment...</title></head><body><div id="cf-challenge-running"><form><input type="hidden" name="x"></form></div></body></html>';
    expect(classifyContent(200, "text/html", html)).toEqual({ kind: "browser", reason: "challenge" });
  });

  it("keeps a long article usable even when it mentions challenge markers", () => {
    expect(classifyContent(200, "text/html", LONG_ARTICLE)).toEqual({ kind: "usable", format: "html" });
  });
});
