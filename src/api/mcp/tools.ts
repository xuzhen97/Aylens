import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";
import { RetrievalError } from "../../core/errors.js";
import { buildAdminOverview } from "../http/admin-data.js";

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

/** Extract 与 Search 分离：必须显式给出来源，不复用 search 的路由默认值。 */
const extractInput = z.object({
  urls: z.array(z.string().min(1)).min(1).max(100),
  sources: z.array(z.string().min(1)).min(1),
  limit: z.number().int().positive().max(100).optional(),
  content: z.object({
    format: z.enum(["markdown", "text"]).optional(),
    maxChars: z.number().int().positive().optional(),
  }).optional(),
});

const providerIdInput = z.object({ providerId: z.string().min(1) });
const loginInput = z.object({ providerId: z.string().min(1), confirm: z.string().min(1) });
const auditInput = z.object({ requestId: z.string().min(1) });
const overviewInput = z.object({ recentAuditLimit: z.number().int().positive().optional() });

/**
 * MCP tool adapter definitions。
 *
 * 这里的工具集必须与 VCPToolBox 插件 AylensBridge 的命令集保持一致：
 * 两者是同一套 Gateway 能力的两个传输面（本文件是**进程内** adapter，
 * AylensBridge 是**远程 HTTP** 客户端）。契约由
 * test/vcp-plugin-contract.test.ts 双向校验，改一边不改另一边会让测试变红。
 */
export function createMcpTools(context: GatewayContext): McpToolDefinition[] {
  return [
    {
      name: "search",
      description: "Search configured retrieval providers through the Aylens gateway.",
      inputSchema: searchInput,
      execute: async (input) => context.search.search(searchInput.parse(input)),
    },
    {
      name: "extract",
      description:
        "Extract full content for explicit URLs. Requires an explicit provider source; returns per-URL success/failure.",
      inputSchema: extractInput,
      execute: async (input) => context.extract.extract(extractInput.parse(input)),
    },
    {
      name: "get_status",
      description: "Report gateway readiness and the number of connected Runner nodes.",
      inputSchema: z.object({}),
      execute: async () => ({ status: "ready", runtimes: context.runtimes.list().length }),
    },
    {
      name: "list_runtimes",
      description: "List currently connected Runner execution nodes.",
      inputSchema: z.object({}),
      execute: async () => ({ runtimes: context.runtimes.list() }),
    },
    {
      name: "list_providers",
      description: "List configured provider definitions (id, type, enabled, runtime target).",
      inputSchema: z.object({}),
      execute: async () => ({
        providers: context.providers.list().map(({ id, config }) => ({
          id,
          type: config.type,
          enabled: config.enabled,
          runtime: config.runtime,
        })),
      }),
    },
    {
      name: "get_overview",
      description:
        "Full gateway overview: providers with auth state, runtimes, browser profiles, and recent audits.",
      inputSchema: overviewInput,
      execute: async (input) => {
        const { recentAuditLimit } = overviewInput.parse(input);
        const overview = buildAdminOverview(context);
        if (recentAuditLimit === undefined) return overview;
        return { ...overview, audits: overview.audits.slice(0, recentAuditLimit) };
      },
    },
    {
      name: "get_audit",
      description: "Read the audit record of a single search request by requestId.",
      inputSchema: auditInput,
      execute: async (input) => {
        const { requestId } = auditInput.parse(input);
        const record = context.audit.get(requestId);
        if (!record) {
          throw new RetrievalError("INVALID_REQUEST", `Audit record not found: ${requestId}`);
        }
        return record;
      },
    },
    {
      name: "check_provider_auth",
      description: "Check the manual login state of a provider (read-only).",
      inputSchema: providerIdInput,
      execute: async (input) => {
        const { providerId } = providerIdInput.parse(input);
        const result = await context.dispatcher.auth(providerId, "check");
        return { providerId, runtimeId: result.runtimeId, auth: result.output };
      },
    },
    {
      name: "login_provider_auth",
      description:
        "Start the interactive login flow for a provider. Side effect: launches a visible Chrome on the Runner.",
      inputSchema: loginInput,
      execute: async (input) => {
        const { providerId, confirm } = loginInput.parse(input);
        if (confirm !== providerId) {
          throw new RetrievalError(
            "INVALID_REQUEST",
            `login_provider_auth 二次确认未通过：confirm 必须与 providerId 完全相同（当前 providerId=${providerId}）`,
          );
        }
        const result = await context.dispatcher.auth(providerId, "login");
        return { providerId, runtimeId: result.runtimeId, auth: result.output };
      },
    },
  ];
}
