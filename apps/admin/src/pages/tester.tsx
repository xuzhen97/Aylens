import { useState, type FormEvent } from "react";
import { useSession } from "../auth/session-context";
import { useOverview } from "../hooks/use-overview";
import type { SearchResponse } from "../api/types";
import { SearchResults } from "../components/search-results";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export function TesterPage() {
  const { client } = useSession();
  const { data } = useOverview();
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState("");
  const [limit, setLimit] = useState(10);
  const [result, setResult] = useState<SearchResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await client.search({ query: query.trim(), limit: Math.min(100, Math.max(1, limit)), ...(providerId ? { sources: [providerId] } : {}) });
      setResult(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检索请求失败");
    } finally {
      setBusy(false);
    }
  }

  return <div><h1 className="mb-2 text-3xl font-semibold">请求测试</h1><p className="mb-6 text-sm text-slate-500">直接验证 Gateway → Runner → Provider 链路</p>
    <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
      <Card><CardHeader><CardTitle>检索参数</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-2"><Label htmlFor="tester-query">查询 / URL</Label><Input id="tester-query" value={query} onChange={(event) => setQuery(event.target.value)} required /></div>
        <div className="space-y-2"><Label htmlFor="tester-provider">Provider</Label><select id="tester-provider" aria-label="Provider" value={providerId} onChange={(event) => setProviderId(event.target.value)} className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"><option value="">使用默认路由</option>{data?.providers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.id} · {p.type}</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="tester-limit">结果上限</Label><Input id="tester-limit" type="number" min={1} max={100} value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></div>
        <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? "执行中…" : "发送请求"}</Button><Button type="button" variant="outline" onClick={() => setResult(undefined)}>清空结果</Button></div>
      </form></CardContent></Card>
      <Card><CardHeader><CardTitle>检索结果</CardTitle></CardHeader><CardContent>{error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}{result ? <SearchResults response={result} /> : <p className="grid min-h-36 place-items-center text-sm text-slate-500">输入 URL 或查询后发送请求。</p>}</CardContent></Card>
    </div>
  </div>;
}
