import { useState } from "react";
import { useSession } from "../auth/session-context";
import { useOverview } from "../hooks/use-overview";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function ProvidersPage() {
  const { data, refresh } = useOverview();
  const { client } = useSession();
  const [working, setWorking] = useState<string>();
  const [notice, setNotice] = useState<string>();

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
      setNotice(error instanceof Error ? error.message : "Provider 操作失败");
    } finally {
      setWorking(undefined);
    }
  }

  const providers = data?.providers ?? [];
  return <div><h1 className="mb-2 text-3xl font-semibold">Providers</h1><p className="mb-6 text-sm text-slate-500">Gateway Provider 定义与认证状态</p>
    {notice ? <p role="status" className="mb-4 rounded-lg bg-slate-100 p-3 text-sm">{notice}</p> : null}
    <div className="grid gap-4 lg:grid-cols-2">{providers.map((provider) => <Card key={provider.id}><CardHeader><div className="flex items-center justify-between"><div><CardTitle className="font-mono text-base">{provider.id}</CardTitle><p className="mt-1 text-sm text-slate-500">{provider.type}</p></div><Badge variant={provider.enabled ? "success" : "destructive"}>{provider.enabled ? "enabled" : "disabled"}</Badge></div></CardHeader><CardContent><div className="space-y-2 text-sm"><p>登录状态：{provider.auth?.status ?? "未检查"}</p><p>账号：{provider.auth?.account?.handle ?? provider.auth?.account?.displayName ?? "—"}</p><p>最后检查：{provider.auth?.checkedAt ? new Date(provider.auth.checkedAt).toLocaleString("zh-CN") : "—"}</p></div>
      {provider.authControl ? <div className="mt-4 flex gap-2 border-t pt-4"><Button variant="outline" size="sm" disabled={Boolean(working)} onClick={() => void auth(provider.id, "login")}>{provider.auth?.status === "auth_required" ? "重新登录" : "登录"}</Button><Button variant="secondary" size="sm" disabled={Boolean(working)} onClick={() => void auth(provider.id, "check")}>检查状态</Button></div> : null}</CardContent></Card>)}</div>
    {providers.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">暂无 Provider</p> : null}
  </div>;
}
