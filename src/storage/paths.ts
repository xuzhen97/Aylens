import { join, resolve } from "node:path";

/**
 * 解析 Gateway 数据库路径。
 * 显式环境变量优先;默认相对进程 cwd 的 `.data/gateway.sqlite`。
 */
export function gatewayDbPath(env: NodeJS.ProcessEnv, cwd: string): string {
  if (env.AYLENS_GATEWAY_DB) return resolve(env.AYLENS_GATEWAY_DB);
  return join(resolve(cwd), ".data", "gateway.sqlite");
}

/**
 * 解析 Runner 数据库路径。
 * 显式环境变量优先;默认按 runner ID 隔离到 `.data/runners/<encoded-id>.sqlite`。
 */
export function runnerDbPath(runnerId: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (env.AYLENS_RUNNER_DB) return resolve(env.AYLENS_RUNNER_DB);
  return join(resolve(cwd), ".data", "runners", `${encodeURIComponent(runnerId)}.sqlite`);
}
