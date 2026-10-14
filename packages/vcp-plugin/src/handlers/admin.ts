import { type AylensClient } from "../client.js";
import { getAudit, getOverview, renderAudit, renderOverview } from "../../../bridge-core/src/index.js";
import { ok } from "../format.js";
import { readNumber, requireString, type VcpParams } from "../params.js";
import type { VcpResponse } from "../types.js";

/** GetAudit —— 按 requestId 查单次检索的审计明细，是排查「为什么没结果」的第一现场。 */
export async function handleGetAudit(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const requestId = requireString(params, "requestId");
	return ok(renderAudit(await getAudit(client, { requestId })));
}

/** GetOverview —— Gateway 总览：Provider 登录态、Runner、浏览器 Profile、最近审计。 */
export async function handleGetOverview(client: AylensClient, params: VcpParams): Promise<VcpResponse> {
	const recentAuditLimit = readNumber(params, "recentAuditLimit");
	return ok(renderOverview(await getOverview(client), recentAuditLimit));
}
