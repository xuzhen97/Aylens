import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderFactory } from "./types.js";
import genericBrowserPlugin from "./generic-browser/index.js";

export interface ProviderPlugin {
  name: string;
  version: string;
  factories: ProviderFactory[];
}

export interface ProviderPluginLoadResult {
  plugins: ProviderPlugin[];
  factories: ProviderFactory[];
}

const BUILTIN_PLUGINS = new Map<string, ProviderPlugin>([
  ["builtin:generic-browser", genericBrowserPlugin],
]);

function moduleSpecifier(moduleRef: string, baseDir: string): string {
  if (moduleRef.startsWith(".") || isAbsolute(moduleRef)) {
    return pathToFileURL(isAbsolute(moduleRef) ? moduleRef : resolve(baseDir, moduleRef)).href;
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
  }

  return candidate as ProviderPlugin;
}

export async function loadProviderPlugins(
  modules: string[],
  baseDir = process.cwd(),
): Promise<ProviderPluginLoadResult> {
  const plugins: ProviderPlugin[] = [];
  const factories: ProviderFactory[] = [];

  for (const moduleRef of modules) {
    const builtin = BUILTIN_PLUGINS.get(moduleRef);
    const imported = builtin ? undefined : await import(moduleSpecifier(moduleRef, baseDir));
    const exported = builtin ?? imported?.default ?? imported?.providerPlugin;
    const plugin = validatePlugin(exported, moduleRef);

    plugins.push(plugin);
    factories.push(...plugin.factories);
  }

  return { plugins, factories };
}
