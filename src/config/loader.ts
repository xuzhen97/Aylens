import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML, { Parser } from "yaml";
import { appConfigSchema, type AppConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g;

type SourceRange = { start: number; end: number };

function yamlCommentRanges(input: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const seen = new Set<object>();

  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const child of value) collect(child);
      return;
    }

    const token = value as Record<string, unknown>;
    if (
      token.type === "comment" &&
      typeof token.offset === "number" &&
      typeof token.source === "string"
    ) {
      ranges.push({
        start: token.offset,
        end: token.offset + token.source.length,
      });
    }

    for (const child of Object.values(token)) collect(child);
  };

  for (const token of new Parser().parse(input)) collect(token);
  return ranges.sort((a, b) => a.start - b.start);
}

export function interpolateEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const comments = yamlCommentRanges(input);
  let commentIndex = 0;

  return input.replace(
    ENV_PATTERN,
    (match, key: string, fallback: string | undefined, offset: number) => {
      for (;;) {
        const current = comments[commentIndex];
        if (!current || current.end > offset) break;
        commentIndex += 1;
      }

      const comment = comments[commentIndex];
      if (comment && offset >= comment.start && offset < comment.end) return match;

      const value = env[key];
      if (value !== undefined) return value;
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing environment variable: ${key}`);
    },
  );
}

export async function loadConfig(
  path = process.env.AYLENS_CONFIG ?? "./config/aylens.yaml",
): Promise<AppConfig> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed: unknown = YAML.parse(interpolateEnv(raw));
  return appConfigSchema.parse(parsed);
}
