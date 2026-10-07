import { useOverview } from "../hooks/use-overview";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

export function OverviewPage() {
  const { data, loading } = useOverview();
  return <div>
    <div className="mb-6"><p className="text-sm font-medium text-slate-500">Aylens Gateway</p><h1 className="mt-1 text-3xl font-semibold">基础设施运行总览</h1><p className="mt-2 text-slate-600">Gateway、Provider、Runtime、Browser Profile 与最近检索摘要。</p></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {[["Gateway", "OK"], ["Providers", `${data?.summary.enabledProviders ?? 0}/${data?.summary.providers ?? 0}`], ["Runtimes", `${data?.summary.onlineRuntimes ?? 0}/${data?.summary.runtimes ?? 0}`], ["Profiles", String(data?.summary.browserProfiles ?? 0)], ["Recent Audits", String(data?.summary.recentAudits ?? 0)]].map(([label, value]) => <Card key={label}><CardHeader className="p-4"><p className="text-xs text-slate-500">{label}</p><CardTitle className="text-2xl">{loading ? "…" : value}</CardTitle></CardHeader></Card>)}
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Runtime 摘要</CardTitle></CardHeader><CardContent className="space-y-2">{data?.runtimes.slice(0, 5).map((item) => <div key={item.id} className="flex justify-between rounded-lg bg-slate-50 p-3 text-sm"><span>{item.id} · {item.hostname}</span><Badge variant={item.status === "online" ? "success" : "warning"}>{item.status}</Badge></div>)}{!data?.runtimes.length ? <p className="text-sm text-slate-500">暂无 Runtime</p> : null}</CardContent></Card>
      <Card><CardHeader><CardTitle>最近检索</CardTitle></CardHeader><CardContent className="space-y-2">{data?.audits.slice(0, 5).map((item) => <div key={item.requestId} className="flex justify-between rounded-lg bg-slate-50 p-3 text-sm"><span className="truncate">{item.request.query}</span><Badge variant={item.status === "completed" ? "success" : "warning"}>{item.status}</Badge></div>)}{!data?.audits.length ? <p className="text-sm text-slate-500">暂无检索记录</p> : null}</CardContent></Card>
    </div>
  </div>;
}
