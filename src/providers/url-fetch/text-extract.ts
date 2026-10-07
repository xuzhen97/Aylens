import { RetrievalError } from "../../core/errors.js";

import type { ExtractedContent } from "./content.js";
import { htmlToMarkdown, limitMarkdown, markdownToPlainText, normalizePlainText, sanitizeMarkdown } from "./markdown.js";

export type MarkdownFormat = "markdown" | "text";

export function extractMarkdown(body: string, options: { maxMarkdownChars: number; maxTextChars: number }): ExtractedContent {
  const sanitized = sanitizeMarkdown(body);
  const limited = limitMarkdown(sanitized.markdown, options.maxMarkdownChars);
  const text = limitPlain(markdownToPlainText(limited.markdown), options.maxTextChars);

  return {
    markdown: limited.markdown,
    text,
    extractionMethod: "markdown",
    truncated: limited.truncated,
    warnings: sanitized.warnings,
  };
}

/**
 * 纯文本按 Markdown 兼容文本返回：不转义、不解析，也不把其中的 HTML 当作可信标记。
 * 下游若要渲染，仍须当作非可信内容处理。
 */
export function extractPlainText(body: string, options: { maxMarkdownChars: number; maxTextChars: number }): ExtractedContent {
  const limited = limitMarkdown(body, options.maxMarkdownChars);

  return {
    markdown: limited.markdown,
    text: limitPlain(normalizePlainText(limited.markdown), options.maxTextChars),
    extractionMethod: "text",
    truncated: limited.truncated,
    warnings: [],
  };
}

function limitPlain(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
