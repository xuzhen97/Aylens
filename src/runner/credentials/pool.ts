import { RetrievalError } from "../../core/errors.js";
import { credentialSecretHash } from "./store.js";
import type {
  CredentialFailure,
  CredentialPoolRecord,
  CredentialRecord,
  CredentialRuntimeState,
  CredentialStateEntry,
} from "./types.js";

/** 取凭据时的额外限制条件。endpointGroup 用于同一服务商不同接口组的独立限流。 */
export interface AcquireOptions {
  endpointGroup?: string | undefined;
  signal?: AbortSignal | undefined;
  now?: number | undefined;
}

/**
 * 一次凭据占用。secret 只存在于本对象与调用方栈上，
 * 不进入日志、审计或返回给 Gateway 的任何字段。
 */
export interface CredentialLease {
  credentialId: string;
  secret: string;
  service: string;
  accountGroup?: string | undefined;
  /** 凭据内容指纹：替换后旧回报不会污染新凭据状态。 */
  credentialVersion: string;
  reportSuccess(meta?: { usage?: { used?: number; limit?: number | null; unit: string } }): void;
  reportFailure(failure: CredentialFailure): void;
  release(): void;
}

interface RuntimeEntry {
  credential: CredentialRecord;
  fingerprint: string;
  inFlight: number;
  maxConcurrency: number;
}

interface AccountBlock {
  /** undefined 表示无限期阻断，直到人工解除或配置变更。 */
  until?: number | undefined;
  kind: "cooling" | "quota_blocked";
}

const DEFAULT_MAX_CONCURRENCY = 4;

/** 内容指纹变了就说明这把 Key 已经不是当时取到的那一把。 */
function fingerprint(credential: CredentialRecord): string {
  return credentialSecretHash(
    `${credential.id}|${credential.secret}|${credential.enabled}|${credential.accountGroup ?? ""}`,
  );
}

/**
 * 凭据池：可用 Key 轮询、并发占用、冷却与分层限流协调。
 *
 * 只负责“选哪把 Key、能不能换下一把”，不构造服务商请求、不解释上游错误 ——
 * 后两者属于服务商适配器。分层（Key / 账号 / 接口组）是本类的核心：
 * 账号级限流时换同账号的另一个 Key 毫无意义，继续轮换只会雪上加霜。
 * 见 docs/adr/2026-10-09-api-credential-pool-scheduling.md。
 */
export class CredentialPool {
  private pools = new Map<string, CredentialPoolRecord>();
  private entries = new Map<string, RuntimeEntry>();
  private state = new Map<string, CredentialStateEntry>();
  private accountBlocks = new Map<string, AccountBlock>();
  private endpointBlocks = new Map<string, Map<string, number>>();
  private cursors = new Map<string, number>();
  private readonly maxConcurrency: number;
  private readonly now: () => number;

  constructor(
    state: CredentialRuntimeState,
    options: { now?: (() => number) | undefined; maxConcurrency?: number | undefined } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.replaceState(state);
  }

  /** 整体替换活动状态。运行中的 lease 指纹失效后，其回报会被忽略。 */
  replaceState(next: CredentialRuntimeState): void {
    this.pools = new Map(next.pools.map((pool) => [pool.id, pool]));
    this.state = new Map(Object.entries(next.state));

    const retained = new Map<string, RuntimeEntry>();
    for (const credential of next.credentials) {
      const previous = this.entries.get(credential.id);
      const contentFingerprint = fingerprint(credential);
      const keepOccupancy = previous !== undefined && previous.fingerprint === contentFingerprint;
      retained.set(credential.id, {
        credential,
        fingerprint: contentFingerprint,
        // 保留进行中的占用，避免配置热更新瞬间把并发额度翻倍。
        inFlight: keepOccupancy ? previous.inFlight : 0,
        maxConcurrency: this.maxConcurrency,
      });
    }
    this.entries = retained;

    // 账号级阻断只在状态里保留“已知阻断”，不由本地猜测恢复时间。
    this.rebuildAccountBlocks();
  }

  availability(credentialId: string): CredentialRuntimeState["state"][string]["availability"] {
    return this.statusOf(credentialId, this.now());
  }

  /**
   * 单一状态判定源：`availability()` 与 `tryAcquire()` 都走这里，
   * 避免“界面显示可用但调度取不到”（或反过来）的两套真相。
   */
  private statusOf(
    credentialId: string,
    now: number,
  ): CredentialStateEntry["availability"] | "available" {
    const entry = this.entries.get(credentialId);
    if (!entry) return "unknown";
    if (!entry.credential.enabled) return "disabled";

    const account = this.accountStatus(entry.credential.accountGroup);
    if (account === "quota_blocked") return "quota_blocked";
    if (account === "cooling") return "cooling";

    const recorded = this.state.get(credentialId);
    if (recorded === undefined) return "available";
    if (recorded.availability === "auth_failed" || recorded.availability === "quota_blocked") {
      return recorded.availability;
    }
    if (recorded.availability === "cooling") {
      // 有到期时间则按时间算：过期即恢复，不能让持久化的 "cooling" 永久卡住。
      if (recorded.cooldownUntil === undefined) return "available";
      return recorded.cooldownUntil > now ? "cooling" : "available";
    }
    return recorded.availability;
  }

  /**
   * 取一把可用凭据并占用一个并发额度。
   * 没有可用凭据时抛 PROVIDER_UNAVAILABLE，details.reason 说明具体原因供界面提示。
   */
  acquire(poolId: string, options: AcquireOptions = {}): CredentialLease {
    const lease = this.tryAcquire(poolId, options);
    if (lease) return lease;

    throw new RetrievalError(
      "PROVIDER_UNAVAILABLE",
      `No usable credential: ${poolId} (${this.describeFailure(poolId)})`,
      { retryable: false, details: { reason: this.describeFailure(poolId), poolId } },
    );
  }

  /** 同 acquire，但无可用凭据时返回 undefined 而不是抛错。 */
  tryAcquire(poolId: string, options: AcquireOptions = {}): CredentialLease | undefined {
    const now = options.now ?? this.now();
    const pool = this.pools.get(poolId);
    if (!pool || !pool.enabled) return undefined;

    const candidates = [...this.entries.values()]
      .filter((entry) => entry.credential.poolId === poolId)
      .filter((entry) => this.isSelectable(entry, options.endpointGroup, now))
      .sort((a, b) => (a.inFlight / a.maxConcurrency) - (b.inFlight / b.maxConcurrency));
    if (candidates.length === 0) return undefined;

    const cursor = (this.cursors.get(poolId) ?? 0) % candidates.length;
    this.cursors.set(poolId, (cursor + 1) % candidates.length);
    const entry = candidates[cursor]!;

    entry.inFlight += 1;
    return this.createLease(entry);
  }

  private isSelectable(entry: RuntimeEntry, endpointGroup: string | undefined, now: number): boolean {
    if (!entry.credential.enabled) return false;
    if (entry.inFlight >= entry.maxConcurrency) return false;
    if (this.statusOf(entry.credential.id, now) !== "available") return false;

    if (endpointGroup !== undefined) {
      const until = this.endpointBlocks.get(entry.credential.accountGroup ?? "")?.get(endpointGroup);
      if (until !== undefined && until > now) return false;
    }
    return true;
  }

  private accountStatus(accountGroup: string | undefined): "cooling" | "quota_blocked" | undefined {
    if (accountGroup === undefined) return undefined;
    const block = this.accountBlocks.get(accountGroup);
    if (!block) return undefined;
    if (block.until !== undefined && block.until <= this.now()) {
      this.accountBlocks.delete(accountGroup);
      return undefined;
    }
    return block.kind;
  }

  private describeFailure(poolId: string): string {
    const pool = this.pools.get(poolId);
    if (!pool) return "pool_missing";
    if (!pool.enabled) return "pool_disabled";

    const entries = [...this.entries.values()].filter((entry) => entry.credential.poolId === poolId);
    if (entries.length === 0) return "no_credentials";
    if (entries.every((entry) => !entry.credential.enabled)) return "all_disabled";

    const statuses = entries.map((entry) => this.availability(entry.credential.id));
    if (statuses.every((status) => status === "auth_failed")) return "auth_failed";
    if (statuses.every((status) => status === "quota_blocked")) return "quota_blocked";
    return "cooling";
  }

  private createLease(entry: RuntimeEntry): CredentialLease {
    let released = false;
    let settled = false;
    const credentialId = entry.credential.id;

    const isCurrent = () => this.entries.get(credentialId)?.fingerprint === entry.fingerprint;

    return {
      credentialId,
      secret: entry.credential.secret,
      service: this.pools.get(entry.credential.poolId)?.service ?? "",
      accountGroup: entry.credential.accountGroup,
      credentialVersion: entry.fingerprint,

      reportSuccess: () => {
        if (settled || !isCurrent()) return;
        settled = true;
        const current = this.state.get(credentialId);
        this.state.set(credentialId, {
          ...(current ?? { availability: "available" as const }),
          availability: "available",
          lastSuccessAt: this.now(),
        });
        // 账号曾被限流并已收到明确恢复时间的，成功说明额度回来了。
        if (entry.credential.accountGroup !== undefined) {
          const block = this.accountBlocks.get(entry.credential.accountGroup);
          if (block?.kind === "cooling") this.accountBlocks.delete(entry.credential.accountGroup);
        }
      },

      reportFailure: (failure) => {
        if (settled || !isCurrent()) return;
        settled = true;
        this.applyFailure(entry, failure);
      },

      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(credentialId);
        if (current?.fingerprint !== entry.fingerprint) return;
        current.inFlight = Math.max(0, current.inFlight - 1);
      },
    };
  }

  private applyFailure(entry: RuntimeEntry, failure: CredentialFailure): void {
    const now = this.now();
    const credentialId = entry.credential.id;

    // 请求级与逐项内容失败不改变凭据健康：换 Key 也一样错。
    if (failure.scope === "request") return;
    if (failure.category === "invalid_request" || failure.category === "item_content") return;

    const accountGroup = entry.credential.accountGroup;

    if (failure.scope === "account" && accountGroup !== undefined) {
      if (failure.category === "quota") {
        // 上游没给恢复时间就不能猜：保持阻断，等人工清除或重新检查。
        this.accountBlocks.set(accountGroup, { kind: "quota_blocked" });
      } else if (failure.retryAfterMs !== undefined) {
        this.accountBlocks.set(accountGroup, {
          kind: "cooling",
          until: now + failure.retryAfterMs,
        });
      } else {
        this.accountBlocks.set(accountGroup, { kind: "cooling" });
      }
      this.record(credentialId, { category: failure.category });
      return;
    }

    if (failure.scope === "endpoint_group") {
      const endpointGroup = failure.endpointGroup;
      if (endpointGroup !== undefined) {
        const map = this.endpointBlocks.get(accountGroup ?? "") ?? new Map<string, number>();
        if (failure.retryAfterMs !== undefined) map.set(endpointGroup, now + failure.retryAfterMs);
        this.endpointBlocks.set(accountGroup ?? "", map);
      }
      this.record(credentialId, { category: failure.category });
      return;
    }

    if (failure.scope === "credential") {
      if (failure.category === "auth") {
        this.state.set(credentialId, {
          availability: "auth_failed",
          lastFailureCategory: "auth",
        });
        return;
      }
      if (failure.category === "quota") {
        this.state.set(credentialId, {
          availability: "quota_blocked",
          lastFailureCategory: "quota",
        });
        return;
      }
      if (failure.retryAfterMs !== undefined) {
        this.state.set(credentialId, {
          availability: "cooling",
          cooldownUntil: now + failure.retryAfterMs,
          lastFailureCategory: failure.category,
        });
        return;
      }
      this.record(credentialId, { category: failure.category });
      return;
    }

    // service / unknown：不判定凭据失效，只记录类别。
    // 服务商整体故障时把每把 Key 逐个拉黑是错误做法。
    this.record(credentialId, { category: failure.category });
  }

  private record(
    credentialId: string,
    update: { category: CredentialFailure["category"] },
  ): void {
    const current = this.state.get(credentialId);
    this.state.set(credentialId, {
      ...(current ?? { availability: "available" as const }),
      lastFailureCategory: update.category,
    });
  }

  /** 账号级阻断不入持久化 state（它属于运行时协调），换状态时从头重建。 */
  private rebuildAccountBlocks(): void {
    // 持久化的 credential 级 quota_blocked 若属于同一账号，视作账号级阻断。
    const blocked = new Map<string, "quota_blocked">();
    for (const entry of this.entries.values()) {
      const group = entry.credential.accountGroup;
      if (group === undefined) continue;
      if (this.state.get(entry.credential.id)?.availability === "quota_blocked") {
        blocked.set(group, "quota_blocked");
      }
    }
    for (const [group, kind] of blocked) {
      if (!this.accountBlocks.has(group)) this.accountBlocks.set(group, { kind });
    }
  }
}

export type { CredentialFailure };
