import { CredentialStore, credentialSecretHash } from "./store.js";
import type { CredentialRuntimeState, SafeCredentialConfig } from "./types.js";

/**
 * 固定分类的安全错误。消息不回显 secret、不回显 Zod issue、不回显上游文案。
 * code 与代理配置服务保持一致，便于 Gateway 统一映射 HTTP 状态。
 */
export class CredentialConfigError extends Error {
  constructor(
    readonly code:
      | "CONFIG_VERSION_CONFLICT"
      | "CONFIG_INVALID"
      | "CONFIG_IN_USE"
      | "CONFIG_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "CredentialConfigError";
  }
}

/**
 * 凭据配置变更。每个变更是独立的一次原子提交。
 *
 * - `secret` 可省略：更新名称/启停时保留已存秘密，避免每次编辑都要重新输入；
 * - 不提供“写入脱敏占位符”的路径，占位符永远不能当作真实凭据保存。
 */
export type CredentialMutation =
  | { kind: "put-pool"; id: string; service: string; name: string; enabled: boolean }
  | { kind: "delete-pool"; id: string }
  | {
    kind: "put-credential";
    id: string;
    poolId: string;
    name: string;
    secret?: string | undefined;
    enabled: boolean;
    accountGroup?: string | undefined;
  }
  | { kind: "delete-credential"; id: string }
  | { kind: "set-pool-enabled"; id: string; enabled: boolean }
  | { kind: "set-credential-enabled"; id: string; enabled: boolean }
  | { kind: "clear-state"; id: string }
  | { kind: "bind"; providerId: string; poolId: string | null };

export interface CredentialWrite {
  operationId: string;
  expectedVersion: number;
  mutation: CredentialMutation;
}

/**
 * 凭据配置服务：校验引用与版本、执行原子提交、产出脱敏视图。
 *
 * 活动快照(`snapshot()`)只在**写入完全成功后**替换：
 * 校验失败或事务回滚都不会让运行态与数据库出现半更新。
 * 见 docs/adr/2026-10-09-runner-api-credential-management.md。
 */
export class CredentialConfigService {
  private active: CredentialRuntimeState;

  constructor(
    private readonly store: CredentialStore,
    /** Provider ID → 部署的 Provider type，用于校验池的服务归属。 */
    private readonly providerTypes: Record<string, string> = {},
  ) {
    this.active = store.read();
  }

  /** 权威持久状态。运行态请用 snapshot()，不要直接读这个做调度决策。 */
  readState(): CredentialRuntimeState {
    return this.store.read();
  }

  safeView(): SafeCredentialConfig {
    const view = this.store.safeView();
    // 列出全部已部署 Provider（未绑定为 null），与代理配置视图保持一致：
    // 若只列已绑定项，管理界面就无法知道还有哪些 Provider 待绑定。
    const bound = new Map(view.providers.map((provider) => [provider.id, provider.poolId]));
    return {
      ...view,
      providers: Object.keys(this.providerTypes).map((providerId) => ({
        id: providerId,
        poolId: bound.get(providerId) ?? null,
        // 服务类型下发到界面，用于只展示能被该 Provider 使用的池。
        service: this.providerTypes[providerId],
      })),
    };
  }

  /** 不可变活动快照：新任务读到它，不会看到半更新状态。 */
  snapshot(): CredentialRuntimeState {
    return this.active;
  }

  write(write: CredentialWrite): SafeCredentialConfig {
    const current = this.store.read();
    if (current.version !== write.expectedVersion) {
      throw new CredentialConfigError(
        "CONFIG_VERSION_CONFLICT",
        `Credential config version conflict: expected ${write.expectedVersion}, current ${current.version}`,
      );
    }

    const next: CredentialRuntimeState = {
      version: current.version + 1,
      pools: current.pools.map((pool) => ({ ...pool })),
      credentials: current.credentials.map((credential) => ({ ...credential })),
      bindings: { ...current.bindings },
      state: Object.fromEntries(
        Object.entries(current.state).map(([id, entry]) => [id, { ...entry }]),
      ),
      lastOperationId: write.operationId,
    };

    this.applyMutation(next, write.mutation);
    this.store.write(next);
    // 只有持久化成功才切换活动快照；失败路径不会执行到这里。
    this.active = this.store.read();
    return this.safeView();
  }

  private applyMutation(next: CredentialRuntimeState, mutation: CredentialMutation): void {
    switch (mutation.kind) {
      case "put-pool": {
        if (!mutation.id.trim() || !mutation.service.trim()) {
          throw new CredentialConfigError("CONFIG_INVALID", "Credential pool requires an id and service");
        }
        const existing = next.pools.find((pool) => pool.id === mutation.id);
        if (existing && existing.service !== mutation.service) {
          throw new CredentialConfigError(
            "CONFIG_INVALID",
            `Credential pool service cannot change after creation: ${mutation.id}`,
          );
        }
        if (!existing) {
          next.pools.push({
            id: mutation.id,
            service: mutation.service,
            name: mutation.name,
            enabled: mutation.enabled,
          });
        } else {
          existing.name = mutation.name;
          existing.enabled = mutation.enabled;
        }
        return;
      }

      case "delete-pool": {
        if (!next.pools.some((pool) => pool.id === mutation.id)) {
          throw new CredentialConfigError("CONFIG_INVALID", `Unknown credential pool: ${mutation.id}`);
        }
        const bound = Object.values(next.bindings).includes(mutation.id);
        if (bound) {
          throw new CredentialConfigError(
            "CONFIG_IN_USE",
            `Credential pool is still bound to a provider: ${mutation.id}`,
          );
        }
        if (next.credentials.some((credential) => credential.poolId === mutation.id)) {
          throw new CredentialConfigError(
            "CONFIG_IN_USE",
            `Credential pool still holds credentials: ${mutation.id}`,
          );
        }
        next.pools = next.pools.filter((pool) => pool.id !== mutation.id);
        return;
      }

      case "put-credential": {
        const pool = next.pools.find((candidate) => candidate.id === mutation.poolId);
        if (!pool) {
          throw new CredentialConfigError(
            "CONFIG_INVALID",
            `Credential references unknown pool: ${mutation.poolId}`,
          );
        }

        const existing = next.credentials.find((credential) => credential.id === mutation.id);
        const secret = mutation.secret ?? existing?.secret;
        if (secret === undefined || secret.length === 0) {
          throw new CredentialConfigError("CONFIG_INVALID", "Credential requires a secret");
        }

        // 同一把 Key 重复登记会虚构出额外并发容量：必须拒绝。
        const duplicate = next.credentials.find(
          (credential) => credential.id !== mutation.id && credential.secret === secret,
        );
        if (duplicate) {
          throw new CredentialConfigError(
            "CONFIG_INVALID",
            `Duplicate credential secret already registered: ${duplicate.id}`,
          );
        }

        if (existing) {
          existing.poolId = mutation.poolId;
          existing.name = mutation.name;
          existing.secret = secret;
          existing.enabled = mutation.enabled;
          existing.accountGroup = mutation.accountGroup;
        } else {
          next.credentials.push({
            id: mutation.id,
            poolId: mutation.poolId,
            name: mutation.name,
            secret,
            enabled: mutation.enabled,
            ...(mutation.accountGroup !== undefined ? { accountGroup: mutation.accountGroup } : {}),
            createdAt: Date.now(),
          });
        }
        return;
      }

      case "delete-credential": {
        if (!next.credentials.some((credential) => credential.id === mutation.id)) {
          throw new CredentialConfigError("CONFIG_INVALID", `Unknown credential: ${mutation.id}`);
        }
        next.credentials = next.credentials.filter((credential) => credential.id !== mutation.id);
        delete next.state[mutation.id];
        return;
      }

      case "set-pool-enabled": {
        const pool = next.pools.find((candidate) => candidate.id === mutation.id);
        if (!pool) {
          throw new CredentialConfigError("CONFIG_INVALID", `Unknown credential pool: ${mutation.id}`);
        }
        pool.enabled = mutation.enabled;
        return;
      }

      case "set-credential-enabled": {
        const credential = next.credentials.find((candidate) => candidate.id === mutation.id);
        if (!credential) {
          throw new CredentialConfigError("CONFIG_INVALID", `Unknown credential: ${mutation.id}`);
        }
        credential.enabled = mutation.enabled;
        return;
      }

      case "clear-state": {
        if (!next.credentials.some((credential) => credential.id === mutation.id)) {
          throw new CredentialConfigError("CONFIG_INVALID", `Unknown credential: ${mutation.id}`);
        }
        delete next.state[mutation.id];
        return;
      }

      case "bind": {
        if (mutation.poolId === null) {
          delete next.bindings[mutation.providerId];
          return;
        }
        const pool = next.pools.find((candidate) => candidate.id === mutation.poolId);
        if (!pool) {
          throw new CredentialConfigError(
            "CONFIG_INVALID",
            `Provider binding references unknown pool: ${mutation.poolId}`,
          );
        }
        const providerType = this.providerTypes[mutation.providerId];
        if (providerType === undefined) {
          throw new CredentialConfigError(
            "CONFIG_INVALID",
            `Unknown provider deployment: ${mutation.providerId}`,
          );
        }
        if (providerType !== pool.service) {
          throw new CredentialConfigError(
            "CONFIG_INVALID",
            `Provider service does not match pool service: ${mutation.providerId} -> ${pool.service}`,
          );
        }
        next.bindings[mutation.providerId] = mutation.poolId;
        return;
      }
    }
  }
}

export { credentialSecretHash };
