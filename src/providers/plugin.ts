import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import type { ProviderFactory } from "./types.js";
import { PROVIDER_CAPABILITIES } from "./types.js";
import urlFetchPlugin from "./url-fetch/index.js";
import xSearchPlugin from "./x-search/index.js";
import tavilyPlugin from "./tavily/index.js";

export interface ProviderPlugin {
  name: string;
  version: string;
  factories: ProviderFactory[];
}

export interface ProviderPluginLoadResult {
  plugins: ProviderPlugin[];
  factories: ProviderFactory[];
}

interface ProviderPackageManifest {
  formatVersion: 1;
  name: string;
  version: string;
  apiVersion: string;
  entry: string;
  providerTypes: string[];
}

const BUILTIN_PLUGINS = new Map<string, ProviderPlugin>([
  ["builtin:url-fetch", urlFetchPlugin],
  ["builtin:x-search", xSearchPlugin],
  ["builtin:tavily", tavilyPlugin],
]);

function resolveFileReference(moduleRef: string, baseDir: string): string {
  return isAbsolute(moduleRef) ? moduleRef : resolve(baseDir, moduleRef);
}

function moduleSpecifier(moduleRef: string, baseDir: string): string {
  if (moduleRef.startsWith(".") || isAbsolute(moduleRef)) {
    return pathToFileURL(resolveFileReference(moduleRef, baseDir)).href;
  }
  return moduleRef;
}

function validatePlugin(value: unknown, moduleRef: string): ProviderPlugin {
  if (!value || typeof value !== "object") {
    throw new Error(`Provider plugin did not export an object: ${moduleRef}`);
  }

  const candidate = value as Partial<ProviderPlugin>;
  if (typeof candidate.name !== "string" || typeof candidate.version !== "string" || !Array.isArray(candidate.factories)) {
    throw new Error(`Invalid provider plugin metadata: ${moduleRef}`);
  }

  for (const factory of candidate.factories) {
    if (!factory || typeof factory !== "object" || typeof factory.type !== "string" || typeof factory.create !== "function") {
      throw new Error(`Invalid provider factory in plugin: ${moduleRef}`);
    }
    // capabilities 必须显式声明:缺少时不能假定只支持 search,
    // 否则“声明了 extract 却没实现”会退化成运行时静默降级。
    // 合法值从 PROVIDER_CAPABILITIES 派生,不再单独维护硬编码白名单。
    const capabilities = (factory as { capabilities?: unknown }).capabilities;
    if (!Array.isArray(capabilities)
      || capabilities.length === 0
      || capabilities.some((value) => !(PROVIDER_CAPABILITIES as readonly unknown[]).includes(value))) {
      throw new Error(
        `Provider factory in plugin must declare non-empty capabilities from [${PROVIDER_CAPABILITIES.join(", ")}]: ${moduleRef} (${factory.type})`,
      );
    }
  }

  return candidate as ProviderPlugin;
}

function validatePackageManifest(value: unknown, moduleRef: string): ProviderPackageManifest {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Provider package manifest: ${moduleRef}`);
  }

  const manifest = value as Partial<ProviderPackageManifest>;
  if (
    manifest.formatVersion !== 1 ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    typeof manifest.apiVersion !== "string" ||
    typeof manifest.entry !== "string" ||
    !Array.isArray(manifest.providerTypes) ||
    manifest.providerTypes.some((type) => typeof type !== "string")
  ) {
    throw new Error(`Invalid Provider package manifest: ${moduleRef}`);
  }

  if (manifest.entry !== basename(manifest.entry) || !manifest.entry.endsWith(".mjs")) {
    throw new Error(`Provider package entry must be a top-level .mjs file: ${moduleRef}`);
  }

  return manifest as ProviderPackageManifest;
}

async function loadProviderPackage(moduleRef: string, baseDir: string): Promise<ProviderPlugin> {
  const archivePath = resolveFileReference(moduleRef, baseDir);
  const archive = await readFile(archivePath);
  const files = unzipSync(archive);
  const manifestBytes = files["provider.json"];
  if (!manifestBytes) {
    throw new Error(`Provider package is missing provider.json: ${moduleRef}`);
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(strFromU8(manifestBytes));
  } catch (error) {
    throw new Error(`Provider package has invalid provider.json: ${moduleRef}`, { cause: error });
  }
  const manifest = validatePackageManifest(manifestValue, moduleRef);
  const entryBytes = files[manifest.entry];
  if (!entryBytes) {
    throw new Error(`Provider package is missing entry ${manifest.entry}: ${moduleRef}`);
  }

  const digest = createHash("sha256").update(archive).digest("hex");
  const aylensHome = resolve(process.env.AYLENS_HOME ?? join(homedir(), ".aylens"));
  const cacheDir = join(aylensHome, "provider-cache", digest);
  const entryPath = join(cacheDir, manifest.entry);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(entryPath, entryBytes);

  const imported = await import(`${pathToFileURL(entryPath).href}?sha256=${digest}`);
  const plugin = validatePlugin(imported.default ?? imported.providerPlugin, moduleRef);

  if (plugin.name !== manifest.name || plugin.version !== manifest.version) {
    throw new Error(`Provider package manifest does not match exported plugin metadata: ${moduleRef}`);
  }

  const exportedTypes = new Set(plugin.factories.map((factory) => factory.type));
  if (manifest.providerTypes.some((type) => !exportedTypes.has(type)) || exportedTypes.size !== manifest.providerTypes.length) {
    throw new Error(`Provider package providerTypes do not match exported factories: ${moduleRef}`);
  }

  return plugin;
}

export async function loadProviderPlugins(
  modules: string[],
  baseDir = process.cwd(),
): Promise<ProviderPluginLoadResult> {
  const plugins: ProviderPlugin[] = [];
  const factories: ProviderFactory[] = [];

  for (const moduleRef of modules) {
    const builtin = BUILTIN_PLUGINS.get(moduleRef);
    let plugin: ProviderPlugin;

    if (builtin) {
      plugin = validatePlugin(builtin, moduleRef);
    } else if (moduleRef.endsWith(".aylens-provider")) {
      plugin = await loadProviderPackage(moduleRef, baseDir);
    } else {
      const imported = await import(moduleSpecifier(moduleRef, baseDir));
      plugin = validatePlugin(imported.default ?? imported.providerPlugin, moduleRef);
    }

    plugins.push(plugin);
    factories.push(...plugin.factories);
  }

  return { plugins, factories };
}
