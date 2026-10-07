import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import { RetrievalError } from "../../core/errors.js";
import type { ContentFormat, ExtractedContent } from "./content.js";
import { htmlToMarkdown, limitMarkdown, normalizePlainText } from "./markdown.js";
import type { UrlFetchOptions } from "./options.js";
import { extractMarkdown, extractPlainText } from "./text-extract.js";

/** 明显不是正文的地标与不可执行内容：Readability 不清理 <nav>，必须自己来。 */
const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "nav",
  "footer",
  "aside",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "[role=complementary]",
  "[role=search]",
];

const URL_ATTRIBUTES = ["href", "src", "poster"];
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function parseStaticDocument(html: string): Document {
  // SAFETY: linkedom 提供了 Readability 与本模块所需的 DOM 表面（nodeName / childNodes /
  // querySelector / textContent / getAttribute 等），但并非 lib.dom 的完整实现；
  // 这里按 Document 使用是有意为之的适配，静态解析全程不执行脚本、不加载子资源。
  return parseHTML(html).document as unknown as Document;
}

export function extractContent(
  body: string,
  url: string,
  format: ContentFormat,
  options: UrlFetchOptions,
): ExtractedContent {
  if (format === "markdown") return extractMarkdown(body, options);
  if (format === "text") return extractPlainText(body, options);
  return extractHtml(body, url, options);
}

function extractHtml(body: string, url: string, options: UrlFetchOptions): ExtractedContent {
  const document = parseStaticDocument(body);
  if (!document.body) {
    throw new RetrievalError("CONTENT_UNAVAILABLE", "Document has no body element");
  }

  assertElementBudget(document, options.maxDomElements);

  const base = resolveBase(document, url);
  const title = normalizePlainText(document.querySelector("title")?.textContent ?? "") || undefined;
  const canonicalUrl = resolveCanonical(document, base);

  cleanDocument(document, base);

  const { element, method } = selectCandidate(document, options);
  const limited = limitMarkdown(htmlToMarkdown(element.innerHTML), options.maxMarkdownChars);

  return {
    markdown: limited.markdown,
    text: limitPlain(normalizePlainText(element.textContent ?? ""), options.maxTextChars),
    title,
    canonicalUrl,
    extractionMethod: method,
    truncated: limited.truncated,
    warnings: [],
  };
}

interface Candidate {
  element: Element;
  method: string;
}

function selectCandidate(document: Document, options: UrlFetchOptions): Candidate {
  if (options.contentSelector) return selectBySelector(document, options.contentSelector);

  const body = document.body;
  if (!body) throw new RetrievalError("CONTENT_UNAVAILABLE", "Document has no body element");
  if (options.contentMode === "full") return { element: body, method: "body" };

  const semantic = pickSemanticContainer(document) ?? body;
  const readable = readableCandidate(document);

  if (options.contentMode === "article") {
    return readable ? { element: readable, method: "readability" } : { element: semantic, method: "semantic" };
  }

  if (!readable) return { element: semantic, method: "semantic" };

  const semanticText = normalizePlainText(semantic.textContent ?? "").length;
  const readableText = normalizePlainText(readable.textContent ?? "").length;

  // Readability 在文档型页面上会静默丢弃表格/代码块，也会过度压缩正文；
  // 这两种情况都改用语义容器，宁可多带一点噪声，也不静默少内容。
  const structuralLoss = hasStructuralContent(semantic) && !hasStructuralContent(readable);
  if (structuralLoss || (semanticText > 0 && readableText < semanticText * 0.6)) {
    return { element: semantic, method: "semantic" };
  }

  return { element: readable, method: "readability" };
}

function selectBySelector(document: Document, selector: string): Candidate {
  let element: Element | null;

  try {
    element = document.querySelector(selector);
  } catch (error) {
    throw new RetrievalError(
      "INVALID_REQUEST",
      `contentSelector is not a valid CSS selector: ${selector}`,
      { cause: error },
    );
  }

  // 明确失败：绝不静默改抓整页，否则配置错误会表现为"结果不对但没报错"。
  if (!element) {
    throw new RetrievalError("CONTENT_UNAVAILABLE", `contentSelector matched no element: ${selector}`);
  }

  return { element, method: "selector" };
}

function readableCandidate(document: Document): Element | undefined {
  // Readability 会就地改写传入的文档，因此必须在副本上运行。
  const clone = document.cloneNode(true);
  // SAFETY: cloneNode 返回 linkedom 节点，其形状满足 Readability 需要的 Document 接口。
  const article = new Readability(clone as unknown as Document, { charThreshold: 0 }).parse();
  if (!article?.content) return undefined;

  const holder = parseStaticDocument(article.content);
  const element = holder.body?.firstElementChild ?? holder.body;
  return element ?? undefined;
}

function pickSemanticContainer(document: Document): Element | undefined {
  let best: Element | undefined;
  let bestLength = 0;

  for (const selector of ["main", "article", "[role=main]"]) {
    for (const element of document.querySelectorAll(selector)) {
      const length = normalizePlainText(element.textContent ?? "").length;
      if (length > bestLength) {
        best = element;
        bestLength = length;
      }
    }
  }

  return best;
}

function hasStructuralContent(element: Element): boolean {
  return element.querySelector("table, pre, code, ul, ol") !== null;
}

function cleanDocument(document: Document, base: string): void {
  for (const selector of NOISE_SELECTORS) {
    for (const element of [...document.querySelectorAll(selector)]) element.remove();
  }

  // 站点页头通常挂在 body 直属位置；article 内部的 <header> 可能承载标题，不能一律删除。
  const body = document.body;
  if (body) {
    for (const child of [...body.children]) {
      if (child.tagName === "HEADER") child.remove();
    }
  }

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of URL_ATTRIBUTES) rewriteUrlAttribute(element, attribute, base);

    for (const attribute of [...element.getAttributeNames()]) {
      if (attribute.toLowerCase().startsWith("on")) element.removeAttribute(attribute);
    }
  }
}

function rewriteUrlAttribute(element: Element, attribute: string, base: string): void {
  const value = element.getAttribute(attribute);
  if (value === null) return;

  const resolved = resolveUrl(value, base);
  if (resolved === undefined) {
    // 无法解析为允许协议的地址（含 javascript:/data: 等）直接去掉，绝不带进 Markdown。
    element.removeAttribute(attribute);
    return;
  }

  element.setAttribute(attribute, resolved);
}

function resolveBase(document: Document, pageUrl: string): string {
  const declared = document.querySelector("base[href]")?.getAttribute("href");
  if (declared) {
    const resolved = resolveUrl(declared, pageUrl);
    if (resolved?.startsWith("http")) return resolved;
  }

  // linkedom 的 parseHTML 不接收 URL，相对地址必须显式按最终 URL 解析，
  // 否则相对链接会静默保持相对形态。
  return pageUrl;
}

function resolveCanonical(document: Document, base: string): string | undefined {
  const declared = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (!declared) return undefined;

  const resolved = resolveUrl(declared, base);
  return resolved?.startsWith("http") ? resolved : undefined;
}

function resolveUrl(value: string, base: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  try {
    const resolved = new URL(trimmed, base);
    return ALLOWED_PROTOCOLS.has(resolved.protocol) ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 元素预算：这是规模限制，不是可中断的 CPU 超时（同步解析无法被 Promise 超时打断）。
 * 输入字节上限由 Transport 层保证，这里再挡一次 DOM 规模。
 */
function assertElementBudget(document: Document, maxElements: number): void {
  const count = document.querySelectorAll("*").length;
  if (count > maxElements) {
    throw new RetrievalError(
      "CONTENT_UNAVAILABLE",
      `Document exceeded the element budget (${count} > ${maxElements})`,
    );
  }
}

function limitPlain(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
