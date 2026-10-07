/**
 * url-fetch smoke。
 *
 * 注意：本地回环目标现在会被公网策略拒绝，这是设计要求（fail-closed），不是缺陷。
 * 因此本脚本不再拿 localhost 当抓取目标，也不会为它开例外开关：
 *
 *   1. 验证策略确实拒绝回环/私网目标；
 *   2. 用离线 fixture 验证静态提取链路（不联网）；
 *   3. 仅在设置 AYLENS_SMOKE_URL 时对真实公网 URL 做一次静态获取；
 *   4. 明确报告"真实 Chrome 兜底 smoke 是否执行"，绝不假装跑过。
 */

import { classifyContent } from "../src/providers/url-fetch/content.js";
import { extractContent } from "../src/providers/url-fetch/extract.js";
import { fetchHttpTarget } from "../src/providers/url-fetch/http-fetch.js";
import { createBudget } from "../src/providers/url-fetch/budget.js";
import { parseOptions } from "../src/providers/url-fetch/options.js";
import { parseTargetUrl } from "../src/providers/url-fetch/url-policy.js";
import { DirectTransport } from "../src/transports/direct.js";
import { isPublicAddress } from "../src/transports/network-policy.js";

const options = parseOptions({});
const ARTICLE_FIXTURE = [
  "<!doctype html><html><head><title>Smoke Article</title></head><body>",
  '<nav><a href="/x">nav noise</a></nav>',
  "<main><h1>Extraction</h1><p>Offline extraction path check.</p>",
  "<pre><code>line one\n  indented line</code></pre></main></body></html>",
].join("");

function check(label: string, condition: boolean): void {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) process.exitCode = 1;
}

// 1) 策略：拒绝回环与私网，字面地址不触发 DNS。
check("policy rejects loopback literal", !isPublicAddress("127.0.0.1"));
check("policy rejects cloud metadata", !isPublicAddress("169.254.169.254"));
check("policy rejects ipv4-mapped loopback", !isPublicAddress("::ffff:127.0.0.1"));
check("policy accepts a public literal", isPublicAddress("93.184.216.34"));

try {
  parseTargetUrl("file:///etc/passwd");
  check("policy rejects file:// targets", false);
} catch {
  check("policy rejects file:// targets", true);
}

// 2) 离线提取：不联网也能验证正文提取与围栏代码。
const extracted = extractContent(ARTICLE_FIXTURE, "https://example.com/smoke", "html", options);
check("offline extraction keeps fenced code", extracted.markdown.includes("```"));
check("offline extraction preserves indentation", extracted.markdown.includes("  indented line"));
check("offline extraction drops navigation", !extracted.markdown.includes("nav noise"));
check("plain text has no fences", !extracted.text.includes("```"));
check(
  "classification accepts a static page",
  classifyContent(200, "text/html", ARTICLE_FIXTURE).kind === "usable",
);

// 3) 可选的真实公网静态获取。
const liveUrl = process.env.AYLENS_SMOKE_URL;

if (liveUrl) {
  const budget = createBudget(undefined, options.timeoutMs);

  try {
    const response = await fetchHttpTarget(
      parseTargetUrl(liveUrl),
      new DirectTransport("direct"),
      {
        maxBytes: options.maxResponseBytes,
        maxDecodedBytes: options.maxDecodedBytes,
        decode: "web",
        redirect: "manual",
        network: "public",
      },
      budget.signal,
    );

    const decision = classifyContent(response.status, response.headers.get("content-type"), response.body);
    const live = decision.kind === "usable"
      ? extractContent(response.body, response.url, decision.format, options)
      : undefined;

    check("live fetch reached the target", response.status > 0);
    check("live fetch produced markdown", (live?.markdown.length ?? 0) > 0);
    console.log(`--- live markdown (first 400 chars) ---\n${live?.markdown.slice(0, 400) ?? "(none)"}`);
  } finally {
    budget.dispose();
  }
} else {
  console.log("SKIP live fetch: set AYLENS_SMOKE_URL to a public http(s) URL to run it");
}

// 4) 诚实报告未覆盖的部分。
console.log(
  "NOT RUN real Chrome fallback smoke: it requires a controlled public fixture plus a deployment whose " +
  "browser egress is already constrained (provider option controlledBrowserEgress). Loopback targets are " +
  "refused by design, so this script does not substitute localhost for that verification.",
);
