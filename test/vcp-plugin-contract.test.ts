import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GatewayContext } from "../src/app/context.js";
import { createMcpTools } from "../src/api/mcp/tools.js";

/**
 * VCPToolBox 插件（AylensBridge）与 MCP tool adapter 是同一套 Gateway 能力的两个传输面。
 * 这个契约测试是两者之间唯一的耦合点：任何一边改了命令集或参数名，另一边不改就会变红。
 */

const root = resolve(__dirname, "..");
const manifestPath = resolve(root, "plugins/aylens/plugin-manifest.json");
const pluginConfigSource = readFileSync(resolve(root, "packages/vcp-plugin/src/config.ts"), "utf8");

interface InvocationCommand {
  command: string;
  description: string;
  example: string;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  name: string;
  version: string;
  configSchema: Record<string, unknown>;
  capabilities: { invocationCommands: InvocationCommand[] };
};

/** PascalCase 命令名 → MCP 的 snake_case 工具名。 */
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** 两个 adapter 共有的参数名全集：用于从描述文本里提取"声称支持的参数"。 */
const KNOWN_PARAMS = new Set([
  "query",
  "route",
  "sources",
  "limit",
  "language",
  "urls",
  "content",
  "providerId",
  "confirm",
  "requestId",
  "recentAuditLimit",
]);

function documentedParams(description: string): string[] {
  const tokens = [...description.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((match) => match[1] as string);
  return [...new Set(tokens.filter((token) => KNOWN_PARAMS.has(token)))].sort();
}

function schemaKeys(schema: z.ZodType): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.keys(schema.shape as Record<string, unknown>).sort();
}

const tools = createMcpTools({} as unknown as GatewayContext);
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

describe("VCP 插件 / MCP adapter 契约", () => {
  it("两个传输面的命令集完全一致（仅命名风格不同）", () => {
    const fromPlugin = manifest.capabilities.invocationCommands.map((item) => toSnakeCase(item.command)).sort();
    const fromMcp = tools.map((tool) => tool.name).sort();
    expect(fromMcp).toEqual(fromPlugin);
  });

  it("插件名与 manifest.name 一致，且每个工具都有非空描述", () => {
    expect(manifest.name).toBe("AylensBridge");
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("每个工具声明的参数与插件描述中记录的参数一一对应", () => {
    for (const item of manifest.capabilities.invocationCommands) {
      const tool = toolsByName.get(toSnakeCase(item.command));
      expect(tool, `MCP 缺少 ${item.command} 对应的工具`).toBeDefined();
      expect(schemaKeys(tool?.inputSchema as z.ZodType), `${item.command} 参数漂移`).toEqual(
        documentedParams(item.description),
      );
    }
  });

  it("插件读取的每个配置项都在 manifest.configSchema 里声明", () => {
    const referenced = new Set(
      [...pluginConfigSource.matchAll(/(?:fileEnv|process\.env)\.([A-Z][A-Z0-9_]*)/g)].map(
        (match) => match[1] as string,
      ),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(Object.keys(manifest.configSchema), `configSchema 缺少 ${key}`).toContain(key);
    }
  });

  it("get_status 直接读取 Runtime 注册表", async () => {
    const context = {
      runtimes: { list: () => [{ id: "runner-1" }, { id: "runner-2" }] },
    } as unknown as GatewayContext;
    const tool = createMcpTools(context).find((item) => item.name === "get_status");
    await expect(tool?.execute({})).resolves.toEqual({ status: "ready", runtimes: 2 });
  });

  it("get_audit 对未知 requestId 抛 INVALID_REQUEST", async () => {
    const context = { audit: { get: () => undefined } } as unknown as GatewayContext;
    const tool = createMcpTools(context).find((item) => item.name === "get_audit");
    await expect(tool?.execute({ requestId: "req-missing" })).rejects.toThrow(/Audit record not found/);
  });

  it("参数校验交给 zod：get_audit 缺少 requestId 时拒绝", async () => {
    const context = { audit: { get: () => undefined } } as unknown as GatewayContext;
    const tool = createMcpTools(context).find((item) => item.name === "get_audit");
    await expect(tool?.execute({})).rejects.toThrow();
  });
});
