import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { AylensClient, type BridgeConfig } from "../../bridge-core/src/client.js";
import { resolveConfig, type PluginConfigInput } from "./config.js";
import { buildExtractTool } from "./tools/extract.js";
import { buildInspectTool } from "./tools/inspect.js";
import { buildLoginTool } from "./tools/login.js";
import { buildSearchTool } from "./tools/search.js";

/** Cordis 插件标识，与 `dsh/cordis.patch.yml` 的行名一致。 */
export const name = "aylens-dsh";

/** 依赖宿主工具注册表。 */
export const inject = ["tools"];

/** 工具定义所需的最小宿主上下文（只声明真正用到的成员）。 */
export interface ToolContext {
	tools: { register(definition: ToolDefinition): () => void };
}

/**
 * 构造 4 个工具定义。
 *
 * 导出它是为了让单元测试能在不启动宿主的情况下直接断言注册集与行为；
 * 4 个工具共享同一个 client，因此共享同一份配置快照。
 *
 * 返回类型写 `ToolDefinition[]` 而不是某个工具的 `ReturnType`：`defineTool` 每次调用
 * 的泛型实例化都不同，用其中一个去装另外三个会类型不兼容。
 */
export function buildTools(config: BridgeConfig): ToolDefinition[] {
	const client = new AylensClient(config);
	return [
		buildSearchTool(client),
		buildExtractTool(client),
		buildInspectTool(client),
		buildLoginTool(client),
	];
}

/** 注册 Aylens 的 4 个原生工具。 */
export function apply(ctx: ToolContext, raw: PluginConfigInput = {}): void {
	for (const definition of buildTools(resolveConfig(raw))) {
		ctx.tools.register(definition);
	}
}
