import type { DatabaseSync } from "node:sqlite";

export interface ProviderSettingOverride {
  providerId: string;
  enabled: boolean;
  updatedAt: number;
}

type SettingRow = {
  provider_id: string;
  enabled: number;
  updated_at: number;
};

/**
 * Provider 启用态覆盖层。
 *
 * 这张表只存"操作员选择与配置文件的偏离"：没有行 = 跟随 config/aylens.yaml。
 * 因此"恢复跟随配置"就是删除该行，不需要额外的状态列。
 * 决策依据见 docs/adr/2026-10-10-runtime-provider-enablement.md。
 *
 * 孤儿行（配置中已删除的 Provider）刻意不清理：投影只遍历已定义的 Provider，
 * 孤儿行天然不可见；清理不可逆，保留的成本接近于零。
 */
export class ProviderSettingStore {
  constructor(private readonly db: DatabaseSync) {}

  loadAll(): ProviderSettingOverride[] {
    const rows = this.db
      .prepare("SELECT provider_id, enabled, updated_at FROM provider_settings")
      .all() as SettingRow[];

    return rows.map((row) => ({
      providerId: row.provider_id,
      enabled: row.enabled !== 0,
      updatedAt: row.updated_at,
    }));
  }

  set(providerId: string, enabled: boolean, now: number): void {
    this.db.prepare(`
      INSERT INTO provider_settings (provider_id, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(providerId, enabled ? 1 : 0, now);
  }

  clear(providerId: string): void {
    this.db.prepare("DELETE FROM provider_settings WHERE provider_id = ?").run(providerId);
  }
}
