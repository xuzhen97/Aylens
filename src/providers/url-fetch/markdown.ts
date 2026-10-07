import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const DANGEROUS_URL = /^(?:javascript|vbscript|data|file):/i;
const FENCE_HEADROOM = 8;

const markdownIt = new MarkdownIt({ html: true });

/**
 * 扫描专用实例：默认的 validateLink 会直接拒绝 javascript: 等协议，
 * 这些构造于是退化成纯文本，根本不会出现在令牌流里。
 * 要识别它们就必须先让它们成为 link 令牌，再由我们按规则中和。
 */
const markdownScanner = new MarkdownIt({ html: true });
markdownScanner.validateLink = () => true;

let turndown: TurndownService | undefined;

function getTurndown(): TurndownService {
  if (turndown) return turndown;

  const service = new TurndownService({
    // 显式指定 atx：默认的 setext 会把标题渲染成 `---` 下划线，层级表达不清。
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  service.use(gfm);
  service.remove(["script", "style", "noscript", "template"]);

  // 裸 <pre>（没有内层 <code>）不会被默认的 fenced 规则命中，会退化成普通段落；
  // 且固定三反引号无法容纳正文里出现的反引号。这里统一自算围栏长度。
  service.addRule("preformattedBlock", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_content, node) => {
      const code = (node.textContent ?? "").replace(/\s+$/, "");
      const language = languageOf(node);
      return `\n\n${fenced(code, language)}\n\n`;
    },
  });

  turndown = service;
  return service;
}

function languageOf(node: HTMLElement): string {
  const source = node.querySelector("code") ?? node;
  const className = source.getAttribute("class") ?? "";
  return /(?:language|lang)-([\w+#.-]+)/i.exec(className)?.[1] ?? "";
}

function fenced(code: string, language: string): string {
  const longestRun = Math.max(
    0,
    ...[...code.matchAll(/`+/g)].map((match) => (match[0] ?? "").length),
  );
  const marker = "`".repeat(Math.max(3, longestRun + 1));
  return `${marker}${language}\n${code}\n${marker}`;
}

export function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(html);
}

/**
 * 原生 Markdown 的安全处理：用 AST 定位，而不是用正则冒充解析器。
 *
 * 块级原始 HTML 依赖 token.map 精确到行，因此代码块里的 HTML 不会被误删。
 * 行内危险构造按其精确字面量替换，绝不凭空生成内容。
 */
export function sanitizeMarkdown(markdown: string): { markdown: string; warnings: string[] } {
  const tokens = markdownScanner.parse(markdown, {});
  const warnings: string[] = [];
  const droppedRanges: Array<[number, number]> = [];
  const unsafeFragments = new Set<string>();

  for (const token of tokens) {
    if (token.type === "html_block") {
      if (token.map) droppedRanges.push([token.map[0], token.map[1]]);
      continue;
    }

    if (token.type !== "inline") continue;

    for (const child of token.children ?? []) {
      if (child.type === "html_inline" && child.content.trim() !== "") {
        unsafeFragments.add(child.content);
      }

      const rawUrl = child.attrGet("href") ?? child.attrGet("src");
      const url = rawUrl === null || rawUrl === undefined ? undefined : String(rawUrl);
      if (url && DANGEROUS_URL.test(url.trim())) unsafeFragments.add(url);
    }
  }

  let lines = markdown.split("\n");

  if (droppedRanges.length > 0) {
    const dropped = new Set<number>();
    for (const [start, end] of droppedRanges) {
      for (let line = start; line < end; line += 1) dropped.add(line);
    }
    lines = lines.filter((_line, index) => !dropped.has(index));
    warnings.push(`Removed ${droppedRanges.length} raw HTML block(s)`);
  }

  let result = lines.join("\n");
  let neutralized = 0;

  for (const fragment of unsafeFragments) {
    const before = result;
    result = result.split(fragment).join(fragment.startsWith("<") ? "" : "#");
    if (result !== before) neutralized += 1;
  }

  if (neutralized > 0) warnings.push(`Neutralized ${neutralized} unsafe inline construct(s)`);

  return { markdown: result, warnings };
}

/** 从 Markdown 派生纯文本：剔除标记，保留代码内容，但不带围栏。 */
export function markdownToPlainText(markdown: string): string {
  const parts: string[] = [];

  for (const token of markdownIt.parse(markdown, {})) {
    switch (token.type) {
      case "inline":
        for (const child of token.children ?? []) {
          if (child.type === "text" || child.type === "code_inline") parts.push(child.content);
          else if (child.type === "softbreak" || child.type === "hardbreak") parts.push("\n");
        }
        parts.push("\n\n");
        break;
      case "fence":
      case "code_block":
        parts.push(`${token.content}\n\n`);
        break;
      default:
        break;
    }
  }

  return normalizePlainText(parts.join(""));
}

export function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * 按块边界截断，并补上未闭合的围栏，避免留下半截代码块把后续内容"吞"进去。
 * 截断只发生在超出上限时，且总长度不会超过上限。
 */
export function limitMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };

  const budget = Math.max(0, maxChars - FENCE_HEADROOM);
  const sliced = markdown.slice(0, budget);
  const blockBoundary = sliced.lastIndexOf("\n\n");
  const lineBoundary = sliced.lastIndexOf("\n");
  const cut = blockBoundary > budget / 2 ? blockBoundary : lineBoundary > 0 ? lineBoundary : sliced.length;

  const closed = closeFences(sliced.slice(0, cut).trimEnd());
  return {
    markdown: closed.length > maxChars ? closed.slice(0, maxChars) : closed,
    truncated: true,
  };
}

function closeFences(markdown: string): string {
  const markers = [...markdown.matchAll(/^(`{3,}|~{3,})/gm)].map((match) => match[1] ?? "```");
  if (markers.length % 2 === 0) return markdown;
  return `${markdown}\n${markers[markers.length - 1] ?? "```"}`;
}
