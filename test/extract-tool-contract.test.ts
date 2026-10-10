import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GatewayContext } from "../src/app/context.js";
import { createMcpTools } from "../src/api/mcp/tools.js";

/**
 * Extract 是新增的独立能力，必须同时出现在两个传输面：
 * MCP adapter 与 VCPToolBox 插件。任何一边漏加都会在这里变红。
 */
const root = resolve(__dirname, "..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "plugins/aylens/plugin-manifest.json"), "utf8"),
) as { capabilities: { invocationCommands: Array<{ command: string; description: string; example: string }> } };

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const tools = createMcpTools({} as unknown as GatewayContext);
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function schemaKeys(schema: z.ZodType): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.keys(schema.shape as Record<string, unknown>).sort();
}

describe("Extract tool contract", () => {
  it("is exposed by both the MCP adapter and the VCP plugin", () => {
    const commands = manifest.capabilities.invocationCommands.map((item) => toSnakeCase(item.command));
    expect(commands).toContain("extract");
    expect(toolsByName.has("extract")).toBe(true);
  });

  it("declares urls and sources, and requires both", () => {
    const tool = toolsByName.get("extract");
    expect(tool).toBeDefined();
    expect(schemaKeys(tool!.inputSchema as z.ZodType)).toEqual(["content", "limit", "sources", "urls"]);
  });

  it("rejects a request without urls", async () => {
    const context = { extract: { extract: async () => ({}) } } as unknown as GatewayContext;
    const tool = createMcpTools(context).find((item) => item.name === "extract");

    await expect(tool?.execute({ sources: ["tavily"] })).rejects.toThrow();
  });

  it("rejects a request without sources", async () => {
    const context = { extract: { extract: async () => ({}) } } as unknown as GatewayContext;
    const tool = createMcpTools(context).find((item) => item.name === "extract");

    await expect(tool?.execute({ urls: ["https://a.example"] })).rejects.toThrow();
  });

  it("delegates to the gateway extract service", async () => {
    const seen: Array<unknown> = [];
    const context = {
      extract: {
        extract: async (request: unknown) => {
          seen.push(request);
          return { requestId: "srch_1", traceId: "trace_1", status: "completed", items: [], meta: { providers: {} } };
        },
      },
    } as unknown as GatewayContext;
    const tool = createMcpTools(context).find((item) => item.name === "extract");

    const result = await tool?.execute({
      urls: ["https://a.example", "https://b.example"],
      sources: ["tavily"],
      limit: 5,
    });

    expect(result).toMatchObject({ requestId: "srch_1", status: "completed" });
    expect(seen[0]).toEqual({
      urls: ["https://a.example", "https://b.example"],
      sources: ["tavily"],
      limit: 5,
    });
  });

  it("keeps the two transport surfaces parameter-aligned", () => {
    const known = new Set(["query", "route", "sources", "limit", "language", "urls", "content"]);
    const documented = (description: string) => [
      ...new Set(
        [...description.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)]
          .map((match) => match[1]!)
          .filter((token) => known.has(token)),
      ),
    ].sort();

    const fromPlugin = manifest.capabilities.invocationCommands.find((item) => item.command === "Extract");
    expect(fromPlugin).toBeDefined();
    expect(schemaKeys(toolsByName.get("extract")!.inputSchema as z.ZodType))
      .toEqual(documented(fromPlugin!.description));
  });
});
