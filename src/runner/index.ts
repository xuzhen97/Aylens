import { loadRunnerConfig } from "./config.js";
import { AylensRunner } from "./runner.js";
import { createRunnerRuntime } from "./runtime.js";

const config = await loadRunnerConfig();
const runtime = await createRunnerRuntime(config);

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
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// `serve()` runs until shutdown: it owns the reconnect loop.
await runner.serve();
