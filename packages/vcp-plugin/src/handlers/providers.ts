import { type AylensClient } from "../client.js";
import { checkProviderAuth, loginProviderAuth, renderProviderAuth } from "../../../bridge-core/src/index.js";
import { ok } from "../format.js";
import { readString, requireString, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

/** CheckProviderAuth —— 只读取登录态，无副作用。 */
export async function handleCheckProviderAuth(
	client: AylensClient,
	params: VcpParams,
): Promise<VcpResponse> {
	const providerId = requireString(params, "providerId");
	return ok(renderProviderAuth(await checkProviderAuth(client, { providerId })));
}

/**
 * LoginProviderAuth —— 在 Runner 上启动一个**可见的**普通 Chrome 并打开登录页。
 *
 * 两道闸门（`allowAuthLogin` 与 `confirm === providerId`）都开在共享核心的
 * `loginProviderAuth` 里，两个宿主的上层都无法绕过。
 */
export async function handleLoginProviderAuth(
	client: AylensClient,
	params: VcpParams,
): Promise<VcpResponse> {
	const providerId = requireString(params, "providerId");
	const confirm = readString(params, "confirm");

	const response = await loginProviderAuth(client, { providerId, confirm: confirm ?? "" });

	return ok(
		[
			`已在 Runner（runtime=${response.runtimeId}）上启动登录流程。`,
			renderProviderAuth(response),
			"",
			"登录窗口由 Runner 侧的 Chrome 承载，请在目标机器上完成操作；本命令不会等待登录完成。",
		].join("\n"),
	);
}
