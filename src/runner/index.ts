import { loadRunnerConfig } from "./config.js";
import { AylensRunner } from "./runner.js";
import { createRunnerRuntime } from "./runtime.js";

const config = await loadRunnerConfig();
const runtime = await createRunnerRuntime(config);
const runner = new AylensRunner(config, runtime);

await runner.connect();
console.log(`Aylens Runner connected: ${config.runner.id}`);

const shutdown = async () => {
  await runner.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
