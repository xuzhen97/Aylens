import type { RuntimeSelectorConfig } from "../config/schema.js";
import { RetrievalError } from "../core/errors.js";
import type { RuntimeRecord } from "./types.js";

function matchesSelector(runtime: RuntimeRecord, selector: RuntimeSelectorConfig): boolean {
  if (runtime.status !== "online" && runtime.status !== "degraded") return false;
  if (runtime.capacity.activeJobs >= runtime.capacity.maxJobs) return false;
  if (selector.os && runtime.os !== selector.os) return false;
  if (selector.providerType && !runtime.capabilities.providerTypes.includes(selector.providerType)) return false;
  if (selector.browser && !runtime.capabilities.browsers.includes(selector.browser)) return false;
  if (selector.profile && !runtime.capabilities.profiles.includes(selector.profile)) return false;

  for (const [key, value] of Object.entries(selector.labels ?? {})) {
    if (runtime.labels[key] !== value) return false;
  }

  return true;
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  constructor(private readonly offlineAfterMs: number) {}

  upsert(runtime: RuntimeRecord): void {
    this.runtimes.set(runtime.id, runtime);
  }

  heartbeat(
    id: string,
    update: Pick<RuntimeRecord, "capabilities" | "capacity" | "lastSeenAt">,
  ): void {
    const current = this.runtimes.get(id);
    if (!current) return;
    this.runtimes.set(id, { ...current, ...update, status: current.status === "draining" ? "draining" : "online" });
  }

  markOffline(id: string): void {
    const current = this.runtimes.get(id);
    if (current) this.runtimes.set(id, { ...current, status: "offline" });
  }

  sweep(now = Date.now()): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.id === "local" || runtime.status === "draining") continue;
      if (now - runtime.lastSeenAt > this.offlineAfterMs) {
        this.runtimes.set(runtime.id, { ...runtime, status: "offline" });
      }
    }
  }

  get(id: string): RuntimeRecord | undefined {
    this.sweep();
    return this.runtimes.get(id);
  }

  select(selector: RuntimeSelectorConfig): RuntimeRecord {
    this.sweep();
    const candidates = [...this.runtimes.values()]
      .filter((runtime) => matchesSelector(runtime, selector))
      .sort((a, b) => (a.capacity.activeJobs / a.capacity.maxJobs) - (b.capacity.activeJobs / b.capacity.maxJobs));

    const runtime = candidates[0];
    if (!runtime) {
      throw new RetrievalError("NO_COMPATIBLE_RUNTIME", "No compatible runtime is currently available", {
        retryable: true,
      });
    }
    return runtime;
  }

  list(): RuntimeRecord[] {
    this.sweep();
    return [...this.runtimes.values()];
  }
}
