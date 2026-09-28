import { spawn } from "node:child_process";

const windows = process.platform === "win32";

// Reuse the npm scripts so the commands have one definition (`npm run dev`,
// `npm run dev:runner`) and npm injects node_modules/.bin into PATH.
const children = ["dev", "dev:runner"].map((name) =>
  spawn(`npm run ${name}`, { stdio: "inherit", shell: true }),
);

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid == null || child.exitCode !== null) continue;
    // npm -> shell -> tsx -> node is a process tree; killing only the top
    // leaves the node child running and holding port 3000 / the Chrome profile.
    if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 700);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

for (const child of children) {
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`a dev process exited (${code ?? "signal"}), stopping the rest`);
    stop();
  });
}
