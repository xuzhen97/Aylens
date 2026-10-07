import { useState } from "react";
import type { FormEvent } from "react";
import type { ApiError } from "../api/types";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export function LoginPage({ onLogin }: { onLogin: (apiKey: string) => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !apiKey) return;
    const submittedKey = apiKey;
    setPending(true);
    setError(undefined);
    try {
      await onLogin(submittedKey);
      setApiKey("");
      sessionStorage.removeItem("aylens.admin.apiKey");
    } catch (cause) {
      const failure = cause as Partial<ApiError>;
      setError(failure.status === 429
        ? `登录尝试过多，请在 ${failure.retryAfterSeconds ?? "稍后"} 秒后重试。`
        : failure.message ?? "登录失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  return <main className="grid min-h-screen place-items-center bg-slate-50 p-4">
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500">AYLENS CONTROL PLANE</p>
        <CardTitle className="text-2xl">管理员登录</CardTitle>
        <CardDescription>使用当前 Gateway API Key 登录；该 Key 不会保存在浏览器。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor="gateway-api-key">Gateway API Key</Label>
            <Input id="gateway-api-key" type="password" autoComplete="current-password" required
              value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <Button type="submit" disabled={pending || !apiKey} className="w-full">
            {pending ? "正在验证…" : "登录"}
          </Button>
        </form>
      </CardContent>
    </Card>
  </main>;
}
