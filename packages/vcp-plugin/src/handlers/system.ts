import { type AylensClient } from "../client.js";
import {
	getStatus,
	listProviders,
	listRuntimes,
	renderProviders,
	renderRuntimes,
	renderStatus,
} from "../../../bridge-core/src/index.js";
import { ok } from "../format.js";
import type { VcpResponse } from "../types.js";

/**
 * 三条诊断命令的薄适配。
 *
 * 「Provider 真实可用操作」的事实来自 Runner 心跳上报的 `providerOperations`，
 * 取数时必须把 `/v1/runtimes` 一起拿回来——这一点由 `bridge-core` 的 `listProviders` 负责。
 */

/** Gateway 自身健康 + 在线 Runner 数量。注意 /ready 不是 Provider 探针。 */
export async function handleGetStatus(client: AylensClient): Promise<VcpResponse> {
	return ok(renderStatus(await getStatus(client)));
}

/** 已连接的 Runner 执行节点及其能力。 */
export async function handleListRuntimes(client: AylensClient): Promise<VcpResponse> {
	const { runtimes } = await listRuntimes(client);
	return ok(renderRuntimes(runtimes));
}

/** Provider 定义 + 真实可用操作。 */
export async function handleListProviders(client: AylensClient): Promise<VcpResponse> {
	return ok(renderProviders(await listProviders(client)));
}
