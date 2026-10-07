import type { SearchResponse } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

function safeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function SearchResults({ response }: { response: SearchResponse }) {
  const failures = Object.entries(response.meta.providers).filter(([, item]) => item.status === "failed");
  return <div className="space-y-3" aria-live="polite">
    <p className="text-sm text-slate-500">{response.status} · {response.items.length} 条 · {response.requestId}</p>
    {failures.map(([providerId, item]) => <Card key={providerId} className="border-red-200">
      <CardHeader><CardTitle className="flex items-center justify-between text-base">
        {providerId}<Badge variant="destructive">{item.error?.code ?? "UNKNOWN_ERROR"}</Badge>
      </CardTitle></CardHeader>
      <CardContent>
        <p>{item.error?.message ?? "Provider 执行失败，但没有返回错误消息。"}</p>
        <p className="mt-2 text-xs text-slate-500">Runtime: {item.runtimeId ?? "未返回"} · retryable: {String(item.error?.retryable ?? false)} · latency: {item.latencyMs} ms</p>
      </CardContent>
    </Card>)}
    {response.items.map((item) => <Card key={item.id}>
      <CardHeader>
        {safeLink(item.url)
          ? <a className="font-semibold text-blue-700 underline-offset-4 hover:underline" href={item.url} target="_blank" rel="noopener noreferrer">{item.title || item.url}</a>
          : <span className="font-semibold">{item.title || item.url || "未命名结果"}</span>}
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm">{(item.text || item.snippet || "").slice(0, 3000)}</p>
        <p className="mt-2 text-xs text-slate-500">{item.platform} · {item.provenance.provider} · {item.provenance.runtimeId ?? ""}</p>
      </CardContent>
    </Card>)}
    {response.items.length === 0 && failures.length === 0
      ? <div className="grid min-h-36 place-items-center text-sm text-slate-500">请求完成，但没有返回结果。</div>
      : null}
  </div>;
}
