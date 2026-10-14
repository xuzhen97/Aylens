import { defineTool } from "@deepseek-ai/dsh-tools";
import { type AylensClient } from "../../../bridge-core/src/client.js";
import { loginProviderAuth } from "../../../bridge-core/src/operations.js";
import { renderProviderAuth } from "../../../bridge-core/src/render.js";
import { assertConfigured } from "../config.js";

/**
 * 强副作用单独成器，以便独立门禁。
 *
 * 两道闸门（`allowAuthLogin` 默认 false、`confirm` 须与 `providerId` 全等）开在
 * 共享核心的 `loginProviderAuth` 里，DSH 侧的上层无法绕过。
 *
 * 刻意**不**依赖 DSH 的审批 seam：`ctx.approval` 未部署时 `ask` 会退化成拒绝，
 * 把一个会莫名永久失败的机制当默认行为是不可接受的。
 */
const DESCRIPTION =
	"在 Runner 上拉起一个【可见的 Chrome】并打开该 Provider 的登录页。" +
	"【强副作用】会打断目标机器上正在复用同一浏览器 Profile 的进行中任务，" +
	"且【不等待登录完成】——返回只表示登录窗口已打开，需要人工在目标机器上完成登录与 2FA。" +
	"默认关闭：必须先把本插件 config 段的 allowAuthLogin 设为 true 才可用。" +
	"confirm 必须与 providerId 完全相同，作为二次确认。";

export function buildLoginTool(client: AylensClient) {
	return defineTool({
		name: "aylens_login",
		description: DESCRIPTION,
		parameters: {
			providerId: { type: "string", required: true, description: "目标 Provider 实例 id。" },
			confirm: {
				type: "string",
				required: true,
				description: "必须与 providerId 完全相同，作为二次确认。",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					providerId: { type: "string", required: true },
					runtimeId: { type: "string", required: true },
					launched: { type: "boolean", required: true },
					text: { type: "string", required: true },
				},
			},
			render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
		},
		presentCall: (args) => ({
			card: "generic",
			title: `在 Runner 上打开 ${(args as { providerId: string }).providerId} 的登录页`,
		}),
		async execute(args, exec) {
			assertConfigured(client.config);
			const response = await loginProviderAuth(
				client,
				{ providerId: args.providerId, confirm: args.confirm },
				exec.signal,
			);
			return {
				providerId: args.providerId,
				runtimeId: response.runtimeId,
				launched: true,
				text: [
					`已在 Runner（runtime=${response.runtimeId}）上启动登录流程。`,
					renderProviderAuth(response),
					"",
					"登录窗口由 Runner 侧的 Chrome 承载，请在目标机器上完成操作；本工具不会等待登录完成。",
				].join("\n"),
			};
		},
	});
}
