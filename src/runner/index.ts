import { loadRunnerConfig } from "./config.js";
import { maintainConnection } from "./connect.js";
import { AylensRunner } from "./runner.js";
import { createRunnerRuntime } from "./runtime.js";

const config = await loadRunnerConfig();
const runtime = await createRunnerRuntime(config);
const runner = new AylensRunner(config, runtime);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await runner.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await maintainConnection(runner, () => stopping, {
  onConnected: () => console.log(`Aylens Runner connected: ${config.runner.id}`),
});
