import { useOverview } from "../hooks/use-overview";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function AuditsPage() {
  const { data } = useOverview();
  const audits = data?.audits ?? [];
  return <div><h1 className="mb-2 text-3xl font-semibold">检索审计</h1><p className="mb-6 text-sm text-slate-500">最近 30 条脱敏检索记录</p>
    <Card><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>状态</TableHead><TableHead>请求</TableHead><TableHead>Provider / Runtime</TableHead><TableHead>耗时</TableHead></TableRow></TableHeader><TableBody>{audits.map((audit) => <TableRow key={audit.requestId}><TableCell>{new Date(audit.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell><Badge variant={audit.status === "completed" ? "success" : "warning"}>{audit.status}</Badge></TableCell><TableCell><span className="font-mono">{audit.request.query}</span><div className="text-xs text-slate-500">{audit.requestId}</div></TableCell><TableCell>{audit.providers.map((p) => `${p.providerId}${p.runtimeId ? ` · ${p.runtimeId}` : ""}`).join(", ") || "—"}</TableCell><TableCell>{audit.completedAt ? `${Math.max(0, audit.completedAt - audit.createdAt)} ms` : "—"}</TableCell></TableRow>)}</TableBody></Table></Card>
    {audits.length === 0 ? <p className="mt-4 rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">暂无检索记录</p> : null}
  </div>;
}
