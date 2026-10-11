import { useState } from "react";
import { useOverview } from "../hooks/use-overview";
import { useSession } from "../auth/session-context";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import type {
  CredentialAvailability,
  CredentialWrite,
  ProviderUsageReport,
  SafeCredentialConfig,
} from "../api/credential-types";

const AVAILABILITY_LABEL: Record<CredentialAvailability, { text: string; tone: string }> = {
  available: { text: "可用", tone: "bg-emerald-100 text-emerald-800" },
  cooling: { text: "冷却中", tone: "bg-amber-100 text-amber-800" },
  auth_failed: { text: "认证失效", tone: "bg-red-100 text-red-800" },
  quota_blocked: { text: "额度阻断", tone: "bg-red-100 text-red-800" },
  disabled: { text: "已停用", tone: "bg-slate-100 text-slate-600" },
  unknown: { text: "未知", tone: "bg-slate-100 text-slate-600" },
};

/**
 * 用量数据的来源标注：官方统计、响应报告、本地估算三者可信度不同，
 * 界面必须区分开，不能把估算当成账单。
 */
const ACCURACY_LABEL: Record<ProviderUsageReport["accuracy"], string> = {
  official: "官方统计",
  response: "响应报告",
  estimated: "本地估算",
  unknown: "未知",
};

function newOperationId(): string {
  return `cred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 池的显示标签：有名则「名称（id）」，无名或名字就等于 id 时退回 id。
 *
 * 显示名绝不能替代引用键：下拉的 value 始终是 pool.id，只有可见文本用名称 ——
 * 否则改名之后引用就会跟着漂移。
 */
function poolLabel(pool: { id: string; name?: string | undefined }): string {
  const name = pool.name?.trim();
  return name !== undefined && name.length > 0 && name !== pool.id ? `${name}（${pool.id}）` : pool.id;
}

/**
 * API 凭据池管理：按 Runner 展示池与 Key 的脱敏状态并写入变更。
 *
 * 凭据与浏览器 Profile 是两套独立资源，这里不显示也不操作任何登录态。
 * 读取永远只有 maskedSecret；明文只在新增/替换提交时出现，不回填输入框。
 */
export function CredentialsPage() {
  const { data } = useOverview();
  const { client } = useSession();
  const [selectedRunnerId, setSelectedRunnerId] = useState<string>("");
  const [config, setConfig] = useState<SafeCredentialConfig | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  /** 把错误码拼进去：运维需要错误码才能处置，光有 message 不够。 */
  const describeError = (failure: unknown, fallback: string) => {
    const message = failure instanceof Error ? failure.message : "";
    const code = (failure as { code?: string } | null)?.code;
    return code && !message.includes(code) ? `${code}: ${message || fallback}` : (message || fallback);
  };

  // 新增/替换 Key 的表单。提交后立即清空：明文不留在页面状态里。
  const [poolId, setPoolId] = useState("");
  const [credentialName, setCredentialName] = useState("");
  const [secret, setSecret] = useState("");
  /** 账号/团队分组：账号级限流靠它识别同组 Key；不填则该层限流不生效。 */
  const [accountGroup, setAccountGroup] = useState("");
  /** 非空表示正在原地替换这个 Key（同一 id + 新 secret），保留可用性状态。 */
  const [editingCredentialId, setEditingCredentialId] = useState<string | undefined>(undefined);
  // Provider → 池绑定。默认选中首个，便于直接操作。
  // Provider → 池绑定：按 Provider 分别记住选择，默认首个可选池。
  const [bindPoolByProvider, setBindPoolByProvider] = useState<Record<string, string>>({});
  /** 用量查询结果按 Provider 分别保存；pending 表示查询中，无键表示尚未查过。 */
  const [usageByProvider, setUsageByProvider] = useState<Record<
    string,
    { pending?: boolean; report?: ProviderUsageReport; error?: string }
  >>({});

  /** 新建池表单。服务只能是本 Runner 已部署的 Provider type（下拉选择），不再前端写死。 */
  const [newPoolService, setNewPoolService] = useState("");
  const [newPoolName, setNewPoolName] = useState("");
  /** 非空表示正在给这个池改名（复用 put-pool，只改 name）。 */
  const [renamingPoolId, setRenamingPoolId] = useState<string | undefined>(undefined);
  const [renameName, setRenameName] = useState("");

  const runners = data?.runtimes ?? [];
  const selectedRunner = runners.find((runner) => runner.id === selectedRunnerId)
    ?? runners.find((runner) => runner.status === "online");
  const supported = selectedRunner?.capabilities.credentialConfig === true;

  const loadConfig = async () => {
    if (!selectedRunner) return;
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setConfig(await client.credentialConfig(selectedRunner.id));
    } catch (loadError) {
      setConfig(undefined);
      setError(describeError(loadError, "读取凭据配置失败"));
    } finally {
      setLoading(false);
    }
  };

  const write = async (mutation: CredentialWrite["mutation"], success: string) => {
    if (!selectedRunner || !config) return;
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await client.writeCredentialConfig(selectedRunner.id, {
        operationId: newOperationId(),
        expectedVersion: config.version,
        mutation,
      });
      setConfig(next);
      setNotice(success);
      setSecret("");
    } catch (writeError) {
      const code = (writeError as { code?: string } | null)?.code;
      if (code === "CONFIG_RESULT_UNKNOWN") {
        // 只有“结果待确认”才重新读取核对：不能拿这次回读去抹掉明确的失败信息。
        await loadConfig();
        setNotice("写入结果待确认，已重新读取配置核对；请确认变更是否生效，不要直接重发。");
      } else {
        setError(describeError(writeError, "写入失败"));
      }
    } finally {
      setWorking(false);
    }
  };

  const addCredential = async () => {
    if (!poolId || !credentialName || !secret) {
      setError("请填写池、名称与 Key 明文");
      return;
    }
    await write(
      {
        kind: "put-credential",
        id: `key_${Date.now().toString(36)}`,
        poolId,
        name: credentialName,
        secret,
        enabled: true,
        ...(accountGroup ? { accountGroup } : {}),
      },
      "已保存；明文不回显，列表只显示脱敏标识。",
    );
    setCredentialName("");
    setSecret("");
    setAccountGroup("");
    setEditingCredentialId(undefined);
  };

  /**
   * 原地替换已存在的 Key：复用同一 id + 新 secret，
   * 不走删除重建 —— 后者会连带清掉可用性状态（冷却/认证失效/账号分组）。
   */
  const replaceCredential = async () => {
    if (!config || !editingCredentialId) return addCredential();
    if (!poolId || !credentialName || !secret) {
      setError("请填写池、名称与新 Key 明文");
      return;
    }
    const existing = config.credentials.find((item) => item.id === editingCredentialId);
    await write(
      {
        kind: "put-credential",
        id: editingCredentialId,
        poolId,
        name: credentialName,
        secret,
        // 保留原有启停与账号分组：换密钥不该顺带改变其他语义。
        enabled: existing?.enabled ?? true,
        ...(accountGroup ? { accountGroup } : existing?.accountGroup ? { accountGroup: existing.accountGroup } : {}),
      },
      `已原地轮换 ${credentialName}；可用性状态未变。`,
    );
    setSecret("");
    setCredentialName("");
    setAccountGroup("");
    setEditingCredentialId(undefined);
  };

  const saveCredential = () => (editingCredentialId ? replaceCredential() : addCredential());

  const startReplace = (credential: SafeCredentialConfig["credentials"][number]) => {
    setEditingCredentialId(credential.id);
    setPoolId(credential.poolId);
    setCredentialName(credential.name);
    setAccountGroup(credential.accountGroup ?? "");
    setSecret("");
    setError(undefined);
    setNotice(undefined);
  };

  const cancelEdit = () => {
    setEditingCredentialId(undefined);
    setCredentialName("");
    setSecret("");
    setAccountGroup("");
  };

  /**
   * 把池 ID 显示成名称。
   *
   * Key 行与 Provider 行只持有 poolId，若直接渲染裸 ID，则改名之后这两处
   * 依旧是一串 pool_xxx —— 与池列表对不上，等于白改名。
   */
  const poolLabelOf = (poolId: string): string => {
    const pool = config?.pools.find((candidate) => candidate.id === poolId);
    return pool ? poolLabel(pool) : poolId;
  };

  /**
   * 某 Provider 可用的池：服务类型必须匹配。
   * 把跨服务商的池摆进下拉，只会让人点了才报“service does not match”。
   * 缺 service（旧 Runner / Store 视图）时退回展示全部池，不假设知道。
   */
  const compatiblePools = (provider: SafeCredentialConfig["providers"][number]) =>
    (config?.pools ?? []).filter(
      (pool) => provider.service === undefined || pool.service === provider.service,
    );

  /**
   * 绑定 Provider → 池。
   *
   * **显式接收参数**而不是读组件状态：setState 是异步的，
   * “先 setBindProviderId 再调 bindSelected”会读到旧值，把别的 Provider 绑上去
   * （实测就是这么把 url-fetch 绑到 tavily 池的）。
   */
  const bindProvider = async (providerId: string, poolId: string) => {
    if (!config) return;
    if (!providerId || !poolId) {
      setError("请先创建与这个 Provider 服务匹配的池");
      return;
    }
    await write({ kind: "bind", providerId, poolId }, `已把 ${providerId} 绑定到 ${poolId}`);
  };

  /**
   * 查询单个 Provider 的用量。
   * 未声明该能力的 Provider 显示“不支持”，而不是报错或显示 0 ——
   * 未知必须显式表达，否则运维会把空白当成“额度没用”。
   */
  const queryUsage = async (providerId: string) => {
    setUsageByProvider((current) => ({ ...current, [providerId]: { pending: true } }));
    try {
      const report = await client.providerUsage(providerId);
      setUsageByProvider((current) => ({ ...current, [providerId]: { report } }));
    } catch (failure) {
      const code = (failure as { code?: string } | null)?.code;
      const unsupported = code === "NO_COMPATIBLE_RUNTIME" || code === "PROVIDER_UNAVAILABLE";
      setUsageByProvider((current) => ({
        ...current,
        [providerId]: {
          error: unsupported ? "该 Provider 不支持用量查询" : describeError(failure, "用量查询失败"),
        },
      }));
    }
  };

  /**
   * 可选的池服务：取自本 Runner **已部署**的 Provider type。
   *
   * 不在前端硬编码服务商名：那份名单的唯一真相源是 Runner 的部署配置，
   * 前端写死会在新增服务商时静默过期（exa 就是这么被漏掉的 ——
   * 建出来的池永远只能是 tavily，且服务创建后不可改）。
   */
  const deployedServices = [...new Set(
    (config?.providers ?? [])
      .map((provider) => provider.service)
      .filter((service): service is string => Boolean(service)),
  )].sort();

  /**
   * 新建池。
   *
   * 池 ID 仍自动生成：它是被 Key 与绑定引用的主键，让人手填只会增加冲突面。
   * 服务保留输入值不清空 —— 连续建同服务的多个池是常见操作。
   */
  const createPool = async () => {
    const service = newPoolService.trim();
    if (!service) {
      setError("请填写池的服务类型（必须与 Provider 的 type 一致）");
      return;
    }
    const name = newPoolName.trim();
    const id = `pool_${Date.now().toString(36)}`;
    await write(
      { kind: "put-pool", id, service, name: name || id, enabled: true },
      `已创建池 ${name || id}（服务 ${service}）；服务创建后不可修改。`,
    );
    setPoolId(id);
    setNewPoolName("");
  };

  const startRename = (pool: SafeCredentialConfig["pools"][number]) => {
    setRenamingPoolId(pool.id);
    setRenameName(pool.name);
    setError(undefined);
    setNotice(undefined);
  };

  /**
   * 改名复用同一条 put-pool 写入：id 与 service 保持不变（service 创建后不可改），
   * 但**必须带上当前的 enabled** —— 服务端这条分支会同时更新 name 与 enabled，
   * 漏传会把停用的池悄悄启用。
   */
  const saveRename = async (pool: SafeCredentialConfig["pools"][number]) => {
    const name = renameName.trim() || pool.id;
    await write(
      { kind: "put-pool", id: pool.id, service: pool.service, name, enabled: pool.enabled },
      `已把池 ${pool.id} 命名为 ${name}`,
    );
    setRenamingPoolId(undefined);
  };

  return (
    <div>
      <h1 className="mb-2 text-3xl font-semibold">API 凭据</h1>
      <p className="mb-6 text-sm text-slate-500">
        按 Runner 管理服务商 API Key 池；与浏览器 Profile 无关，凭据仅写入、不回显。
      </p>

      {notice ? (
        <p role="status" className="mb-4 rounded-lg bg-slate-100 p-3 text-sm">{notice}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
      ) : null}

      {runners.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">暂无已连接的 Runner</p>
      ) : (
        <div className="space-y-4">
          <Card className="p-4 flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-600" htmlFor="runner-select">Runner</label>
            <select
              id="runner-select"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedRunner?.id ?? ""}
              onChange={(event) => {
                setSelectedRunnerId(event.target.value);
                setConfig(undefined);
                setError(undefined);
                setNotice(undefined);
              }}
            >
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>{runner.id}({runner.status})</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => void loadConfig()} disabled={loading || !selectedRunner}>
              读取配置
            </Button>
          </Card>

          {selectedRunner && !supported ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              该 Runner 不支持凭据管理（版本过旧或未接入权威配置库），只能查看，无法写入。
            </p>
          ) : null}

          {selectedRunner && config ? (
            <>
              <Card className="p-4">
                <strong className="mb-3 block text-sm">凭据池（版本 {config.version}）</strong>
                {config.pools.length === 0 ? (
                  <p className="text-sm text-slate-500">尚无凭据池</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {config.pools.map((pool) => (
                      <li key={pool.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2">
                        {renamingPoolId === pool.id ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <label className="text-sm">
                              新名称
                              <input
                                className="ml-2 rounded-md border border-input bg-background px-2 py-1 text-sm"
                                value={renameName}
                                onChange={(event) => setRenameName(event.target.value)}
                                placeholder={pool.id}
                              />
                            </label>
                            <span className="font-mono text-xs text-slate-500">
                              {pool.id} · {pool.service}（服务不可改）
                            </span>
                          </span>
                        ) : (
                          <span>
                            {/* 名称在前：满屏 pool_xxx 时人根本找不到自己要的那个池。 */}
                            <span className="font-medium">{pool.name || pool.id}</span>
                            <span className="ml-2 font-mono text-xs text-slate-500">
                              {pool.id} · {pool.service} · {pool.credentialCount} 个 Key
                            </span>
                            {pool.providerRefs.length > 0 ? (
                              <span className="ml-2 text-slate-500">→ {pool.providerRefs.join(", ")}</span>
                            ) : null}
                          </span>
                        )}
                        <span className="flex gap-2">
                          <Badge variant={pool.enabled ? "success" : "secondary"}>
                            {pool.enabled ? "启用" : "停用"}
                          </Badge>
                          {renamingPoolId === pool.id ? (
                            <>
                              <Button
                                size="sm"
                                disabled={working || !supported}
                                onClick={() => void saveRename(pool)}
                              >
                                保存名称
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={working}
                                onClick={() => setRenamingPoolId(undefined)}
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={working || !supported}
                                onClick={() => startRename(pool)}
                              >
                                改名
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={working || !supported}
                                onClick={() => void write(
                                  { kind: "delete-pool", id: pool.id },
                                  `已删除池 ${pool.id}（若仍被引用会返回冲突）`,
                                )}
                              >
                                删除
                              </Button>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-4 space-y-2 border-t border-slate-200 pt-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                      服务
                      {/* 下拉而不是手填：服务取自本 Runner 已部署的 Provider type，
                          手填只会招来拼写错误，而 service 创建后不可改。 */}
                      <select
                        className="ml-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={newPoolService}
                        onChange={(event) => setNewPoolService(event.target.value)}
                      >
                        <option value="">选择服务</option>
                        {deployedServices.map((service) => (
                          <option key={service} value={service}>{service}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      池名称
                      <input
                        className="ml-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={newPoolName}
                        onChange={(event) => setNewPoolName(event.target.value)}
                        placeholder="Tavily 主池"
                      />
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={working || !supported || !newPoolService.trim()}
                      onClick={() => void createPool()}
                    >
                      新建池
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500">
                    {deployedServices.length > 0
                      ? "服务取自本 Runner 已部署的 Provider type，必须一致且创建后不可修改。"
                      : "本 Runner 未部署任何 Provider，无法创建凭据池：先在 Runner 的 runner.yaml 里部署 Provider 并重启。"}
                  </p>
                </div>
              </Card>

              <Card className="p-4">
                <strong className="mb-3 block text-sm">Key 列表</strong>
                {config.credentials.length === 0 ? (
                  <p className="text-sm text-slate-500">尚无凭据</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {config.credentials.map((credential) => {
                      const availability = AVAILABILITY_LABEL[credential.availability];
                      return (
                        <li key={credential.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2">
                          <span>
                            <span className="font-mono">{credential.name}</span>
                            <span className="ml-2 font-mono text-slate-500">{credential.maskedSecret}</span>
                            <span className="ml-2 text-slate-500">池 {poolLabelOf(credential.poolId)}</span>
                            {credential.accountGroup ? (
                              <span className="ml-2 text-slate-500">账号组 {credential.accountGroup}</span>
                            ) : null}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className={`rounded px-2 py-0.5 text-xs ${availability.tone}`}>{availability.text}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={working || !supported}
                              onClick={() => startReplace(credential)}
                            >
                              替换
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={working || !supported}
                              onClick={() => void write(
                                { kind: "set-credential-enabled", id: credential.id, enabled: !credential.enabled },
                                `已${credential.enabled ? "停用" : "启用"} ${credential.name}`,
                              )}
                            >
                              {credential.enabled ? "停用" : "启用"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={working || !supported}
                              onClick={() => void write(
                                { kind: "delete-credential", id: credential.id },
                                `已删除 ${credential.name}`,
                              )}
                            >
                              删除
                            </Button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card className="p-4">
                <strong className="mb-3 block text-sm">Provider 绑定</strong>
                {config.providers.length === 0 ? (
                  <p className="text-sm text-slate-500">当前 Runner 未部署任何 Provider</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {config.providers.map((provider) => (
                      <li key={provider.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2">
                        <span>
                          <span className="font-mono">{provider.id}</span>
                          <span className="ml-2 text-slate-500">
                            {provider.poolId ? `池 ${poolLabelOf(provider.poolId)}` : "未绑定"}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <label className="sr-only" htmlFor={`bind-pool-${provider.id}`}>绑定到池</label>
                          <select
                            id={`bind-pool-${provider.id}`}
                            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                            value={bindPoolByProvider[provider.id] ?? compatiblePools(provider)[0]?.id ?? ""}
                            onChange={(event) => setBindPoolByProvider((current) => ({
                              ...current,
                              [provider.id]: event.target.value,
                            }))}
                          >
                            {compatiblePools(provider).map((pool) => (
                              <option key={pool.id} value={pool.id}>{poolLabel(pool)}</option>
                            ))}
                          </select>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={working || !supported || compatiblePools(provider).length === 0}
                            onClick={() => void bindProvider(
                              provider.id,
                              bindPoolByProvider[provider.id] ?? compatiblePools(provider)[0]?.id ?? "",
                            )}
                          >
                            绑定
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="p-4">
                <strong className="mb-3 block text-sm">用量</strong>
                <p className="mb-3 text-xs text-slate-500">
                  按能力展示：不支持的 Provider 明确标注，未知不显示为 0；不同服务商单位不可互比。
                </p>
                <ul className="space-y-2 text-sm">
                  {config.providers.map((provider) => {
                    const state = usageByProvider[provider.id];
                    return (
                      <li key={provider.id} className="rounded border border-slate-200 p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono">{provider.id}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            // 只在查询进行中禁用：若把“未查过”也算禁用，按钮就永不可用。
                            disabled={working || state?.pending === true}
                            onClick={() => void queryUsage(provider.id)}
                          >
                            查询用量
                          </Button>
                        </div>
                        {state?.error ? (
                          <p className="mt-1 text-xs text-amber-700">{state.error}</p>
                        ) : state?.report ? (
                          <div className="mt-1 space-y-1 text-xs text-slate-600">
                            <p>
                              {ACCURACY_LABEL[state.report.accuracy]} ·
                              {new Date(state.report.fetchedAt).toLocaleString("zh-CN")}
                            </p>
                            {state.report.entries.length === 0 ? (
                              <p>暂无用量数据（未知，不代表已用量为 0）</p>
                            ) : (
                              state.report.entries.map((entry) => (
                                <p key={`${entry.scope}-${entry.unit}`} className="font-mono">
                                  {entry.scope === "credential" ? "Key" : "账号"}：
                                  {entry.used ?? "未知"} / {entry.limit ?? "无上限"} {entry.unit}
                                </p>
                              ))
                            )}
                          </div>
                        ) : state?.pending ? (
                          <p className="mt-1 text-xs text-slate-500">查询中…</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Card>

              <Card className="p-4">
                <strong className="mb-3 block text-sm">
                  {editingCredentialId ? "替换 Key（编辑中）" : "新增 Key"}
                </strong>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm">
                    池 ID
                    <select
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={poolId}
                      onChange={(event) => setPoolId(event.target.value)}
                    >
                      <option value="">选择池</option>
                      {config.pools.map((pool) => (
                        <option key={pool.id} value={pool.id}>{poolLabel(pool)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    名称
                    <input
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={credentialName}
                      onChange={(event) => setCredentialName(event.target.value)}
                      placeholder="primary"
                    />
                  </label>
                  <label className="text-sm">
                    Key 明文
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder="提交后不回显"
                    />
                  </label>
                  <label className="text-sm">
                    账号组（可选）
                    <input
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={accountGroup}
                      onChange={(event) => setAccountGroup(event.target.value)}
                      placeholder="team-a"
                    />
                  </label>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  同一账号/团队的 Key 填同一账号组；否则账号级限流不会在同组 Key 间生效。
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    disabled={working || !supported || !poolId || !credentialName || !secret}
                    onClick={() => void saveCredential()}
                  >
                    保存 Key
                  </Button>
                  {editingCredentialId ? (
                    <Button variant="outline" size="sm" disabled={working} onClick={cancelEdit}>
                      取消编辑
                    </Button>
                  ) : null}
                </div>
              </Card>
            </>
          ) : selectedRunner ? (
            <p className="text-sm text-slate-500">点击“读取配置”加载该 Runner 的凭据设置。</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
