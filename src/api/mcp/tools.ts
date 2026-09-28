import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

const searchInput = z.object({
  query: z.string().min(1),
  route: z.string().optional(),
  sources: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(100).optional(),
  language: z.string().optional(),
});

export function createMcpTools(context: GatewayContext): McpToolDefinition[] {
  return [
    {
      name: "search",
      description: "Search configured retrieval providers through the Aylens gateway.",
      inputSchema: searchInput,
      execute: async (input) => context.search.search(searchInput.parse(input)),
    },
    {
      name: "list_runtimes",
      description: "List currently connected Runner execution nodes.",
      inputSchema: z.object({}),
      execute: async () => ({ runtimes: context.runtimes.list() }),
    },
  ];
}
