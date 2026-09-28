import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { loadConfig } from "../src/config/loader.js";

const GATEWAY_READY_TIMEOUT_MS = 45_000;
const RUNNER_READY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_500;

/**
 * How long to wait after (re)starting the runner before concluding it failed to
 * register. Must cover plugin loading + browser profile registration.
 */
const RUNNER_RESTART_GRACE_MS = 15_000;
const MAX_RUNNER_RESTARTS = 10;

/**
 * How long the gateway may stay unreachable before we respawn it. Covers normal
 * `tsx watch` reloads (~1-3s) without racing them, but still recovers from a
 * gateway that died for good.
 */
const GATEWAY_DOWN_RESTART_MS = 20_000;

const PROBE_PATH = "/ready";

type Role = "gateway" | "runner";

const COLOR: Record<Role | "all", string> = {
  gateway: "\u001b[36m",
  runner: "\u001b[35m",
  all: "\u001b[32m",
};
const RESET = "\u001b[0m";
const COLOR_ENABLED = process.stdout.isTTY === true;

function log(role: Role | "all", message: string): void {
  const label = role === "all" ? "dev:all" : role;
  const prefix = COLOR_ENABLED ? `${COLOR[role]}[${label}]${RESET}` : `[${label}]`;
  process.stdout.write(`${prefix} ${message}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LineFilter = (line: string) => boolean;

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  emit: (line: string) => void,
  keep: LineFilter,
): void {
  let buffered = "";

  stream?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "").trimEnd();
      if (trimmed && keep(trimmed)) emit(trimmed);
    }
  });
}

/**
 * The supervisor polls `/ready` continuously, and fastify logs every request.
 * Drop our own probe traffic, matching the response line by its request id so
 * the two halves of each log pair disappear together.
 */
function createProbeFilter(): LineFilter {
  const probeRequestIds = new Set<string>();

  return (line) => {
    const reqId = /"reqId":"([^"]+)"/.exec(line)?.[1];

    if (line.includes(`"url":"${PROBE_PATH}"`)) {
      if (reqId) probeRequestIds.add(reqId);
      return false;
    }

    if (reqId && line.includes('"msg":"request completed"') && probeRequestIds.delete(reqId)) {
      return false;
    }

    return true;
  };
}

const children = new Map<Role, ChildProcess>();
let shuttingDown = false;
let supervisor: NodeJS.Timeout | undefined;
let runnerRestarts = 0;
let gatewayRestarts = 0;
let runnerEverRegistered = false;
let lastRunnerStartAt = 0;
let gatewayDownSince: number | null = null;
let restarting = false;

function spawnScript(role: Role, script: string): ChildProcess {
  // A single command string rather than `shell: true` plus an argv array:
  // Node 24 deprecates the latter (DEP0190) because the arguments are only
  // concatenated, not escaped. Both commands are fixed literals, no user input.
  const child = spawn(`pnpm run ${script}`, {
    cwd: process.cwd(),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    // POSIX: give the whole tree its own process group so a single signal can
    // reach the real script (and any Chrome it launched), not just the shell.
    // Not on Windows: that would open an extra console window.
    detached: process.platform !== "win32",
  });

  children.set(role, child);

  const keep = role === "gateway" ? createProbeFilter() : () => true;
  pipeLines(child.stdout, (line) => log(role, line), keep);
  pipeLines(child.stderr, (line) => log(role, line), keep);

  return child;
}

/**
 * `pnpm run dev` is a two-level tree (`pnpm` -> `tsx watch` -> the real script),
 * so killing the direct child alone would leave the watcher and the script
 * running. On Windows only `taskkill /T` reaches the descendants.
 */
function killTree(role: Role): void {
  const child = children.get(role);
  if (!child?.pid || child.exitCode !== null) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function shutdown(exitCode: number, reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log("all", `shutting down: ${reason}`);
  if (supervisor) clearInterval(supervisor);

  killTree("runner");
  killTree("gateway");

  setTimeout(() => process.exit(exitCode), 300);
}

let baseUrl = "";

interface ReadinessReport {
  remoteRuntimes: number;
}

async function probe(): Promise<ReadinessReport | undefined> {
  try {
    const response = await fetch(`${baseUrl}${PROBE_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;

    const body = (await response.json()) as { remoteRuntimes?: unknown };
    return {
      remoteRuntimes: typeof body.remoteRuntimes === "number" ? body.remoteRuntimes : 0,
    };
  } catch {
    return undefined;
  }
}

async function waitFor(
  label: string,
  timeoutMs: number,
  check: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(POLL_INTERVAL_MS);
  }

  log("all", `timed out after ${timeoutMs}ms waiting for ${label}`);
  return false;
}

/**
 * Chrome is cached per profile for the whole lifetime of the runner
 * (browser/chrome-profile-host.ts keeps an `opened` map and only closes it from
 * `close()`). A hard kill — closing the terminal window, `taskkill /F`, a crash
 * — therefore leaves Chrome alive still holding the persistent profile, and the
 * next search fails with a misleading `BROWSER_START_FAILED`. Reap any browser
 * pointing at a profile inside this repo before starting the runner.
 */
function reapOrphanedBrowsers(): void {
  if (process.platform !== "win32") return;

  const escapedCwd = process.cwd().replace(/'/g, "''");
  const query =
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
    `Where-Object { $_.CommandLine -like '*${escapedCwd}*' } | ` +
    "Select-Object -ExpandProperty ProcessId";

  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", query], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return;

  const pids = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
  if (pids.length === 0) return;

  log("all", `reaping ${pids.length} leftover Chrome process(es) still holding this repo's profile`);
  for (const pid of pids) {
    spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  }
}

function startGateway(): void {
  const gateway = spawnScript("gateway", "dev");
  gateway.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shutdown(code ?? 1, `gateway exited (${signal ?? code})`);
  });
}

function startRunner(): void {
  lastRunnerStartAt = Date.now();

  const runner = spawnScript("runner", "dev:runner");
  runner.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log("runner", `process exited (${signal ?? code}); supervisor will restart it`);
  });
}

async function restartRunner(): Promise<void> {
  if (runnerRestarts >= MAX_RUNNER_RESTARTS) {
    shutdown(1, `runner failed to register ${MAX_RUNNER_RESTARTS} times in a row`);
    return;
  }

  runnerRestarts += 1;
  log(
    "all",
    `runner is not registered (gateway restarted?) → restarting runner (${runnerRestarts}/${MAX_RUNNER_RESTARTS})`,
  );

  killTree("runner");
  await delay(700);
  if (!shuttingDown) startRunner();
}

async function restartGateway(): Promise<void> {
  gatewayRestarts += 1;
  log("all", `gateway unreachable for ${GATEWAY_DOWN_RESTART_MS}ms → restarting gateway (${gatewayRestarts})`);

  killTree("gateway");
  await delay(1_000);
  if (shuttingDown) return;

  startGateway();
  gatewayDownSince = null;
}

/**
 * Keeps the pair alive across `tsx watch` reloads.
 *
 * The Runner reconnects on its own (see `AylensRunner.serve`), so a Gateway
 * reload no longer strands it. What still needs supervising:
 *
 *  - A reload can lose the port to its own predecessor (`EADDRINUSE` on
 *    Windows), and `tsx watch` then waits forever instead of retrying, so the
 *    Gateway is respawned after `GATEWAY_DOWN_RESTART_MS`.
 *  - If the Runner process itself dies, nothing else brings it back.
 */
async function supervise(): Promise<void> {
  if (shuttingDown || restarting) return;

  restarting = true;
  try {
    const report = await probe();

    if (!report) {
      gatewayDownSince ??= Date.now();
      if (Date.now() - gatewayDownSince >= GATEWAY_DOWN_RESTART_MS) await restartGateway();
      return;
    }

    gatewayDownSince = null;

    if (report.remoteRuntimes >= 1) {
      runnerEverRegistered = true;
      return;
    }

    if (!runnerEverRegistered) return;
    if (Date.now() - lastRunnerStartAt < RUNNER_RESTART_GRACE_MS) return;

    await restartRunner();
  } finally {
    restarting = false;
  }
}

function toProbeHost(host: string): string {
  if (host === "" || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host === "::1") return "[::1]";
  return host;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  baseUrl = `http://${toProbeHost(config.server.host)}:${config.server.port}`;

  log("all", `gateway config: ${process.env.AYLENS_CONFIG ?? "./config/aylens.yaml"}`);
  log("all", `runner  config: ${process.env.AYLENS_RUNNER_CONFIG ?? "./config/runner.yaml"}`);

  startGateway();

  const gatewayUp = await waitFor(`${baseUrl}${PROBE_PATH}`, GATEWAY_READY_TIMEOUT_MS, async () =>
    (await probe()) !== undefined,
  );
  if (!gatewayUp) {
    shutdown(1, "gateway never became ready");
    return;
  }
  log("all", `gateway is up on ${baseUrl}`);

  // Start the Runner after the Gateway so its first registration succeeds
  // instead of burning a few reconnect attempts. (Not a correctness
  // requirement anymore: the Runner retries with backoff.)
  reapOrphanedBrowsers();
  startRunner();

  const runnerUp = await waitFor("runner registration", RUNNER_READY_TIMEOUT_MS, async () => {
    const report = await probe();
    return report !== undefined && report.remoteRuntimes >= 1;
  });

  if (runnerUp) {
    runnerEverRegistered = true;
    log("all", "gateway + runner are ready");
  } else {
    log("all", "runner has not registered yet — the supervisor keeps watching for it");
  }

  log("all", `admin UI: ${baseUrl}/admin`);
  log(
    "all",
    `search:   curl.exe -X POST ${baseUrl}/v1/search -H "Authorization: Bearer ${config.auth.apiKey}" -H "Content-Type: application/json" -d "{\\"query\\":\\"https://example.com\\"}"`,
  );

  supervisor = setInterval(() => void supervise(), POLL_INTERVAL_MS);

  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
}

await main();
