import { loadRunnerStartup } from "./config.js";
import { AylensRunner } from "./runner.js";
import { createRunnerRuntime } from "./runtime.js";

// 必须走权威启动装载:它打开 Runner 数据库、首次导入 YAML 代理并组装 ProxyConfigService。
// 只读 YAML(config-only)会让 runtime.proxyConfig 为 undefined,Runner 上报
// capabilities.proxyConfig=false,Gateway 一律拒绝其配置请求(CONFIG_UNSUPPORTED)。
const startup = await loadRunnerStartup();
const { config } = startup;
const runtime = await createRunnerRuntime(config, { proxyConfig: startup.service });

const runner = new AylensRunner(config, runtime, {
  lifecycle: {
    connected: (runnerId) => {
      console.log(`Aylens Runner connected: ${runnerId}`);
    },
    disconnected: (reason) => {
      console.log(`Aylens Runner disconnected: ${reason}`);
    },
    connectionFailed: (error, attempt, retryInMs) => {
      console.error(
        `Aylens Runner could not reach ${config.runner.gatewayUrl} ` +
          `(attempt ${attempt}, retrying in ${retryInMs}ms): ${error.message}`,
      );
    },
    reconnecting: (attempt, retryInMs) => {
      console.log(`Aylens Runner reconnecting (attempt ${attempt}) in ${retryInMs}ms`);
    },
  },
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runner.close();
  startup.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// `serve()` 会持续运行直到关闭，并负责维护 Runner 的重连循环。
await runner.serve();
