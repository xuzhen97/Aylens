import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { appConfigSchema, type AppConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g;

/**
 * 返回 YAML 行内注释开始的位置；如果整行都是有效内容则返回 -1。 * 只有行首或空白后的 # 才开始注释，引号内的 # 不算注释。 * 这里不解析块标量，其内容继续按有效文本处理，以保持既有环境变量插值行为。
 */
function findCommentStart(line: string): number {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote) {
      if (char !== quote) continue;

      // 引号标量中的连续双引号表示转义后的引号，不能在这里结束引号状态。
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

/** 对有效配置中的环境变量表达式进行插值，但不处理已注释的配置，因此注释示例中的变量无需真实存在。 */
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
