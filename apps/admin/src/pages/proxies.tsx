import { useState } from "react";
import { useOverview } from "../hooks/use-overview";
import { useSession } from "../auth/session-context";
import { ProxyEditor } from "./proxy-editor.js";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";

/** 代理配置页:按 Runner 展示与管理代理;仅在线且支持配置通道的 Runner 可编辑。 */
export function ProxiesPage() {
  const { data } = useOverview();
  const { client } = useSession();
  const [selectedRunnerId, setSelectedRunnerId] = useState<string>("");
  const [config, setConfig] = useState<Awaited<ReturnType<typeof client.proxyConfig>> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const runners = data?.runtimes ?? [];
  const selectedRunner = runners.find((runner) => runner.id === selectedRunnerId)
    ?? runners.find((runner) => runner.status === "online");

  const loadConfig = async () => {
    if (!selectedRunner) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await client.proxyConfig(selectedRunner.id);
      setConfig(next);
    } catch (loadError) {
      setConfig(undefined);
      setError((loadError as Error).message || "读取代理配置失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 className="mb-2 text-3xl font-semibold">代理配置</h1>
      <p className="mb-6 text-sm text-slate-500">按 Runner 管理代理与 Provider 传输绑定;凭据仅写入,不回显。</p>

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
              }}
            >
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.id}({runner.status})
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => void loadConfig()} disabled={loading || !selectedRunner}>
              读取配置
            </Button>
          </Card>

          {error ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
          ) : null}

          {selectedRunner && config ? (
            <ProxyEditor
              runnerId={selectedRunner.id}
              runnerOnline={selectedRunner.status === "online" || selectedRunner.status === "degraded"}
              supportsProxyConfig={selectedRunner.capabilities.proxyConfig === true}
              config={config}
              writeProxyConfig={(runnerId, write, signal) => client.writeProxyConfig(runnerId, write, signal).then((next) => {
                setConfig(next);
                return next;
              })}
            />
          ) : selectedRunner ? (
            <p className="text-sm text-slate-500">点击“读取配置”加载该 Runner 的代理设置。</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
