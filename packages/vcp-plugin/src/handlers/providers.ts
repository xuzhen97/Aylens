import { AylensBridgeError, type AylensClient } from "../client.js";
import { formatAge, ok } from "../format.js";
import { readString, requireString, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

interface ProviderAuthAccount {
	handle: string;
	displayName?: string | undefined;
}

interface ProviderAuthState {
	status: "unknown" | "authenticated" | "auth_required";
	account?: ProviderAuthAccount | undefined;
	checkedAt: number;
}

interface ProviderAuthResponse {
	providerId: string;
	runtimeId: string;
	auth: ProviderAuthState;
}

function formatAuth(providerId: string, runtimeId: string, auth: ProviderAuthState): string {
	const lines = [`Provider ${providerId} · runtime=${runtimeId} · 登录态=${auth.status}`];
	if (auth.account) {
		lines.push(`- 账号: ${auth.account.handle}${auth.account.displayName ? `（${auth.account.displayName}）` : ""}`);
	}
	if (auth.checkedAt) {
		lines.push(`- 检查时间: ${new Date(auth.checkedAt).toISOString()}（${formatAge(auth.checkedAt)}）`);
	}
	if (auth.status === "auth_required") {
		lines.push(
			"",
			"⚠️ 需要人工登录：请在 Aylens Admin（/admin/providers）点「登录」，在弹出的 Chrome 里完成登录与 2FA。",
			"凭据只留在 Runner 的 persistent Profile 中，Gateway 不接触 Cookie。",
		);
	}
	return lines.join("\n");
}

/** CheckProviderAuth —— 只读取登录态，无副作用。 */
export async function handleCheckProviderAuth(
	client: AylensClient,
	params: VcpParams,
): Promise<VcpResponse> {
	const providerId = requireString(params, "providerId");
	const response = await client.post<ProviderAuthResponse>(
		`/v1/providers/${encodeURIComponent(providerId)}/auth/check`,
	);
	return ok(formatAuth(providerId, response.runtimeId, response.auth));
}

/**
 * LoginProviderAuth —— 在 Runner 上启动一个**可见的**普通 Chrome 并打开登录页。
 *
 * 这是本插件唯一的强副作用命令，且它会打断目标机器上正在复用同一 Profile 的浏览器操作，
 * 因此默认关闭：必须显式在 config.env 里设 AYLENS_ALLOW_AUTH_LOGIN=true 才允许调用。
 * VCPToolBox 的 toolApprovalConfig 只能按插件名整包审批，粒度太粗，所以门开在插件内部。
 */
export async function handleLoginProviderAuth(
	client: AylensClient,
	params: VcpParams,
): Promise<VcpResponse> {
	const providerId = requireString(params, "providerId");
	const confirm = readString(params, "confirm");

	if (!client.config.allowAuthLogin) {
		throw new AylensBridgeError(
			"AUTH_LOGIN_DISABLED",
			"LoginProviderAuth 默认关闭：它会在 Runner 上拉起一个可见 Chrome 并可能打断同 Profile 的进行中任务。" +
				"确认要启用时，请在插件目录 config.env 中设置 AYLENS_ALLOW_AUTH_LOGIN=true 并重新加载插件。",
		);
	}
	if (confirm !== providerId) {
		throw new AylensBridgeError(
			"AUTH_LOGIN_DISABLED",
			`二次确认未通过：请把 confirm 参数写成与 providerId 完全相同的值（当前 providerId=${providerId}）。`,
		);
	}

	const response = await client.post<ProviderAuthResponse>(
		`/v1/providers/${encodeURIComponent(providerId)}/auth/login`,
	);
	return ok(
		[
			`已在 Runner（runtime=${response.runtimeId}）上启动登录流程。`,
			formatAuth(providerId, response.runtimeId, response.auth),
			"",
			"登录窗口由 Runner 侧的 Chrome 承载，请在目标机器上完成操作；本命令不会等待登录完成。",
		].join("\n"),
	);
}
