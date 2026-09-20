import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { appConfigSchema, type AppConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g;

export function interpolateEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(ENV_PATTERN, (_match, key: string, fallback: string | undefined) => {
    const value = env[key];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable: ${key}`);
  });
}

export async function loadConfig(
  path = process.env.AYLENS_CONFIG ?? "./config/aylens.yaml",
): Promise<AppConfig> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed: unknown = YAML.parse(interpolateEnv(raw));
  return appConfigSchema.parse(parsed);
}
