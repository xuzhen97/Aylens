import { useState } from "react";
import type { ProxyWrite, SafeProxyConfig } from "../api/proxy-types.js";
import { Card } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Alert } from "../components/ui/alert.js";

export interface ProxyEditorProps {
  runnerId: string;
  runnerOnline: boolean;
  supportsProxyConfig: boolean;
  config: SafeProxyConfig;
  writeProxyConfig: (runnerId: string, write: ProxyWrite, signal?: AbortSignal) => Promise<SafeProxyConfig>;
}

type SaveState = "idle" | "saving" | "unknown";

/**
 * 代理编辑器:凭据仅写入(内存中暂存,成功/失败/切换后清空);
 * unknown 结果不允许再次保存,必须先刷新核对。
 */
export function ProxyEditor({
  runnerId,
  runnerOnline,
  supportsProxyConfig,
  config,
  writeProxyConfig,
}: ProxyEditorProps) {
  const [selectedProxyId, setSelectedProxyId] = useState<string>(
    config.proxies.find((proxy) => proxy.type !== "direct")?.id ?? "direct",
  );
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [message, setMessage] = useState<string | undefined>(undefined);

  const selectedProxy = config.proxies.find((proxy) => proxy.id === selectedProxyId);
  const editable = runnerOnline && supportsProxyConfig && saveState !== "unknown";

  const handleSave = async () => {
    if (!selectedProxy || selectedProxy.type === "direct") return;
    if (!address.trim()) {
      setMessage("代理地址不能为空");
      return;
    }

    const credentials = password
      ? ({ action: "replace", username: username || "proxy", password } as const)
      : ({ action: "keep" } as const);

    const write: ProxyWrite = {
      operationId: crypto.randomUUID(),
      expectedVersion: config.version,
      mutation: {
        kind: "put",
        id: selectedProxy.id,
        type: selectedProxy.type === "socks5" ? "socks5" : "http-proxy",
        address: address.trim(),
        credentials,
      },
    };

    setSaveState("saving");
    setMessage(undefined);
    const controller = new AbortController();
    try {
      await writeProxyConfig(runnerId, write, controller.signal);
      setPassword("");
      setUsername("");
      setSaveState("idle");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "CONFIG_RESULT_UNKNOWN") {
        setSaveState("unknown");
        setMessage("结果待确认:请刷新核对 Runner 当前配置,不要重复保存。");
      } else if (code === "CONFIG_VERSION_CONFLICT") {
        setSaveState("idle");
        setMessage("配置版本冲突:配置已被他人修改,请刷新后重试。草稿已保留。");
      } else {
        setSaveState("idle");
        setMessage((error as Error).message || "保存失败");
      }
    }
  };

  return (
    <div className="space-y-4">
      {saveState === "unknown" ? (
        <Alert>
          结果待确认:请刷新核对 Runner 当前配置,不要重复保存。
        </Alert>
      ) : null}
      {message ? (
        <Alert>
          {message}
        </Alert>
      ) : null}
      {!runnerOnline ? (
        <Alert>
          Runner 离线:无法修改代理配置。
        </Alert>
      ) : null}
      {!supportsProxyConfig ? (
        <Alert>
          该 Runner 不支持代理配置通道(需要升级 Runner)。
        </Alert>
      ) : null}
      {config.browserRestartRequired.length > 0 ? (
        <Alert>
          
            修改被浏览器 Profile 引用的代理后,需重启对应 Chrome 才能生效:
            {config.browserRestartRequired.join(", ")}
          
        </Alert>
      ) : null}

      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="proxy-select">选择代理</Label>
          <select
            id="proxy-select"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={selectedProxyId}
            onChange={(event) => setSelectedProxyId(event.target.value)}
          >
            {config.proxies.map((proxy) => (
              <option key={proxy.id} value={proxy.id}>
                {proxy.id}({proxy.type}
                {proxy.hasCredentials ? ", 认证信息已配置" : ""})
              </option>
            ))}
          </select>
        </div>

        {selectedProxy && selectedProxy.type !== "direct" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="proxy-address">代理地址</Label>
              <Input
                id="proxy-address"
                value={address || selectedProxy.address || ""}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAddress(event.target.value)}
                disabled={!editable}
                placeholder="http://proxy.example.com:8080"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="proxy-username">代理用户名(可选)</Label>
              <Input
                id="proxy-username"
                value={username}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)}
                disabled={!editable}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="proxy-password">代理密码(仅写入,不回显)</Label>
              <Input
                id="proxy-password"
                type="password"
                value={password}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
                disabled={!editable}
                autoComplete="new-password"
              />
            </div>
            <Button onClick={() => void handleSave()} disabled={!editable || saveState === "saving"}>
              保存
            </Button>
            {saveState === "unknown" ? (
              <Button variant="outline" onClick={() => window.location.reload()}>
                刷新核对
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">direct 传输不可修改。</p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">引用关系</h3>
        <ul className="space-y-1 text-sm text-slate-600">
          {config.proxies.map((proxy) => (
            <li key={proxy.id}>
              {proxy.id}:{" "}
              {proxy.providerRefs.length > 0 || proxy.profileRefs.length > 0
                ? [...proxy.providerRefs, ...proxy.profileRefs].join(", ")
                : "无引用"}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
