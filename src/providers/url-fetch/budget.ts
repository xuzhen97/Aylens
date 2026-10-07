export interface Budget {
  signal: AbortSignal;
  remainingMs(): number;
  dispose(): void;
}

/**
 * 一笔总预算：HTTP、传输回退、Profile 排队、浏览器导航、提取与清理都从同一个截止时间扣减，
 * 不允许各阶段各自重新计时（否则最坏情况会叠加成数倍于任务期限的耗时）。
 */
export function createBudget(parent: AbortSignal | undefined, timeoutMs: number): Budget {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const onParentAbort = (): void => controller.abort();

  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
