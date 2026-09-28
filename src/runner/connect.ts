import type { AylensRunner } from "./runner.js";

export const RETRY_MS = 1000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The gateway is not necessarily listening yet — `npm run dev:all` starts both
 * processes at once. Retry the initial connection until it succeeds or shutdown
 * begins.
 */
export async function connectWithRetry(
  runner: Pick<AylensRunner, "connect">,
  isStopping: () => boolean = () => false,
  retryMs: number = RETRY_MS,
): Promise<void> {
  for (;;) {
    try {
      await runner.connect();
      return;
    } catch (error) {
      if (isStopping()) return;
      console.error(`Gateway unreachable: ${(error as Error).message}. Retrying in ${retryMs}ms`);
      await delay(retryMs);
    }
  }
}

export async function maintainConnection(
  runner: Pick<AylensRunner, "connect" | "waitForDisconnect">,
  isStopping: () => boolean = () => false,
  options: {
    retryMs?: number;
    onConnected?: () => void;
  } = {},
): Promise<void> {
  const retryMs = options.retryMs ?? RETRY_MS;

  while (!isStopping()) {
    await connectWithRetry(runner, isStopping, retryMs);
    if (isStopping()) return;

    options.onConnected?.();
    await runner.waitForDisconnect();
    if (isStopping()) return;

    console.error(`Gateway disconnected. Reconnecting in ${retryMs}ms`);
    await delay(retryMs);
  }
}
