import { useState } from "react";
import { useSession } from "../auth/session-context";
import { useOverview } from "../hooks/use-overview";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import type { ProviderEnabledMode } from "../api/types";

/**
 * 旧 Gateway 不下发 enabledMode 时按"跟随配置"处理。
 * 此时不显示"跟随配置"按钮——在信息不足时给出一个看似可用的回退入口更容易误导。
 */
function modeOf(provider: { enabledMode?: ProviderEnabledMode }): ProviderEnabledMode {
  return provider.enabledMode ?? "config";
}

export function ProvidersPage() {
  const { data, refresh } = useOverview();
  const { client } = useSession();
  const [working, setWorking] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** 停用会让依赖该 Provider 的路由整体失效，因此需要二次确认。 */
  const [confirmingDisable, setConfirmingDisable] = useState<string>();

  /** 把错误码拼进去：运维需要错误码才能处置，光有 message 不够。 */
  function describeError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : "";
    const code = (error as { code?: string } | null)?.code;
    return code && !message.includes(code) ? `${code}: ${message || fallback}` : (message || fallback);
  }

  async function auth(providerId: string, action: "login" | "check") {
    setWorking(`${providerId}:${action}`);
    setNotice(undefined);
    try {
      const result = await client.providerAuth(providerId, action);
      setNotice(action === "login"
        ? "已请求 Runner 打开真实 Chrome 登录页；请在 Runner 浏览器中完成登录。"
        : `登录状态：${result.auth.status}`);
      await refresh();
    } catch (error) {
      setNotice(describeError(error, "Provider 操作失败"));
    } finally {
      setWorking(undefined);
    }
  }

  async function setEnabled(providerId: string, mode: ProviderEnabledMode) {
    setWorking(`${providerId}:enabled`);
    setNotice(undefined);
    try {
      const result = await client.setProviderEnabled(providerId, mode);
      setConfirmingDisable(undefined);
      setNotice(`${providerId} 已${result.enabled ? "启用" : "禁用"}（${
        result.enabledSource === "override" ? "手动覆盖" : "跟随配置文件"
      }）`);
      await refresh();
    } catch (error) {
      setNotice(describeError(error, "Provider 操作失败"));
    } finally {
      setWorking(undefined);
    }
  }

  const providers = data?.providers ?? [];
  const busy = Boolean(working);

  return <div><h1 className="mb-2 text-3xl font-semibold">Providers</h1><p className="mb-6 text-sm text-slate-500">Gateway Provider 定义与认证状态</p>
    {notice ? <p role="status" className="mb-4 rounded-lg bg-slate-100 p-3 text-sm">{notice}</p> : null}
    <div className="grid gap-4 lg:grid-cols-2">{providers.map((provider) => {
      const mode = modeOf(provider);
      return <Card key={provider.id}><CardHeader><div className="flex items-center justify-between"><div><CardTitle className="font-mono text-base">{provider.id}</CardTitle><p className="mt-1 text-sm text-slate-500">{provider.type}</p></div><Badge variant={provider.enabled ? "success" : "destructive"}>{provider.enabled ? "已启用" : "已禁用"}</Badge></div></CardHeader><CardContent>
        <div className="space-y-2 text-sm"><p>启用态来源：{mode === "config" ? "跟随配置文件" : "手动覆盖"}</p><p>登录状态：{provider.auth?.status ?? "未检查"}</p><p>账号：{provider.auth?.account?.handle ?? provider.auth?.account?.displayName ?? "—"}</p><p>最后检查：{provider.auth?.checkedAt ? new Date(provider.auth.checkedAt).toLocaleString("zh-CN") : "—"}</p></div>
        <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
          {provider.enabled
            ? (confirmingDisable === provider.id
              ? <>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => void setEnabled(provider.id, "disabled")}>确认停用？</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingDisable(undefined)}>取消</Button>
                </>
              : <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmingDisable(provider.id)}>停用</Button>)
            : <Button variant="secondary" size="sm" disabled={busy} onClick={() => void setEnabled(provider.id, "enabled")}>启用</Button>}
          {mode !== "config" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void setEnabled(provider.id, "config")}>跟随配置</Button> : null}
        </div>
        {provider.enabled ? null : <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">停用后，依赖该 Provider 的路由会以 PROVIDER_DISABLED 失败。启用后仍需有可用 Runner 与凭据池才能真正调用。</p>}
        {provider.authControl ? <div className="mt-4 flex gap-2 border-t pt-4"><Button variant="outline" size="sm" disabled={busy} onClick={() => void auth(provider.id, "login")}>{provider.auth?.status === "auth_required" ? "重新登录" : "登录"}</Button><Button variant="secondary" size="sm" disabled={busy} onClick={() => void auth(provider.id, "check")}>检查状态</Button></div> : null}
      </CardContent></Card>;
    })}</div>
    {providers.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">暂无 Provider</p> : null}
  </div>;
}
