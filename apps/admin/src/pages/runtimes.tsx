import { useOverview } from "../hooks/use-overview";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function RuntimesPage() {
  const { data } = useOverview();
  const runtimes = data?.runtimes ?? [];
  return <div><h1 className="mb-2 text-3xl font-semibold">Runtime / Runner</h1><p className="mb-6 text-sm text-slate-500">{runtimes.length} 个执行节点</p>
    <Card className="hidden md:block"><Table><TableHeader><TableRow><TableHead>Runtime</TableHead><TableHead>状态</TableHead><TableHead>能力</TableHead><TableHead>容量</TableHead><TableHead>最后心跳</TableHead></TableRow></TableHeader><TableBody>{runtimes.map((item) => <TableRow key={item.id}><TableCell>{item.id}<div className="text-xs text-slate-500">{item.hostname} · {item.os} · v{item.version}</div></TableCell><TableCell><Badge variant={item.status === "online" ? "success" : "warning"}>{item.status}</Badge></TableCell><TableCell>{[...item.capabilities.providerTypes, ...item.capabilities.browsers, ...item.capabilities.profiles.map((p) => `profile:${p}`)].join(" · ")}</TableCell><TableCell>{item.capacity.activeJobs} / {item.capacity.maxJobs}</TableCell><TableCell>{new Date(item.lastSeenAt).toLocaleString("zh-CN")}</TableCell></TableRow>)}</TableBody></Table></Card>
    <div className="space-y-3 md:hidden">{runtimes.map((item) => <Card key={item.id}><CardHeader><CardTitle>{item.id}</CardTitle></CardHeader><CardContent>{item.hostname} · {item.os}<p>{item.capacity.activeJobs} / {item.capacity.maxJobs}</p></CardContent></Card>)}</div>
    {runtimes.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">暂无 Runtime</p> : null}
  </div>;
}
