import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { appConfigSchema, type AppConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g;

/**
 * Returns the index at which a YAML comment starts on `line`, or -1 when the
 * whole line is live content.
 *
 * A `#` opens a comment only at the start of a line or after whitespace, and
 * never inside a single- or double-quoted scalar. Block scalars (`|`, `>`) are
 * not modelled: their content is treated as live text, which matches the
 * previous behaviour of interpolating everything that is not a comment.
 */
function findCommentStart(line: string): number {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote) {
      if (char !== quote) continue;

      // A doubled quote inside a quoted scalar escapes that quote.
      if (line[index + 1] === quote) {
        index += 1;
      } else {
        quote = undefined;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#") {
      const previous = line[index - 1];
      if (previous === undefined || /\s/.test(previous)) return index;
    }
  }

  return -1;
}

function interpolateSegment(input: string, env: NodeJS.ProcessEnv): string {
  return input.replace(ENV_PATTERN, (_match, key: string, fallback: string | undefined) => {
    const value = env[key];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable: ${key}`);
  });
}

/**
 * Interpolates `${VAR}` / `${VAR:-fallback}` without touching commented-out
 * configuration. Commented example blocks such as
 * `#   url: "${PROXY_URL}"` must not require the variable to be set.
 */
export function interpolateEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input
    .split("\n")
    .map((line) => {
      const commentStart = findCommentStart(line);

      if (commentStart === -1) return interpolateSegment(line, env);

      return (
        interpolateSegment(line.slice(0, commentStart), env) + line.slice(commentStart)
      );
    })
    .join("\n");
}

export async function loadConfig(
  path = process.env.AYLENS_CONFIG ?? "./config/aylens.yaml",
): Promise<AppConfig> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed: unknown = YAML.parse(interpolateEnv(raw));
  return appConfigSchema.parse(parsed);
}
