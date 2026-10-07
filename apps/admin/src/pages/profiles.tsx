import { useOverview } from "../hooks/use-overview";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export function ProfilesPage() {
  const { data } = useOverview();
  const profiles = data?.browserProfiles ?? [];
  return <div><h1 className="mb-2 text-3xl font-semibold">Browser Profiles</h1><p className="mb-6 text-sm text-slate-500">仅展示 Runner 上报的安全运行状态，不暴露本地路径或登录态。</p>
    <div className="grid gap-4 lg:grid-cols-2">{profiles.map((profile) => <Card key={`${profile.runtimeId}:${profile.id}`}><CardHeader><div className="flex justify-between"><div><CardTitle className="font-mono text-base">{profile.id}</CardTitle><p className="mt-1 text-sm text-slate-500">Runner · {profile.runtimeId}</p></div><Badge variant={profile.status === "available" ? "success" : "warning"}>{profile.status}</Badge></div></CardHeader><CardContent className="grid grid-cols-2 gap-3 text-sm"><span>浏览器</span><strong>{profile.browser ?? "Runner 未上报"}</strong><span>模式</span><strong>{profile.mode ?? "Runner 未上报"}</strong><span>Lease</span><strong>{profile.activeLeases == null || profile.maxConcurrency == null ? "Runner 未上报" : `${profile.activeLeases} / ${profile.maxConcurrency}`}</strong><span>交互</span><strong>{profile.interactive == null ? "Runner 未上报" : profile.interactive ? "是" : "否"}</strong><span>Transport</span><strong>{profile.transport ?? "Runner 未上报"}</strong></CardContent></Card>)}</div>
    {profiles.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">暂无 Browser Profile</p> : null}
  </div>;
}
