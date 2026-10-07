import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createAdminClient, type AdminClient } from "../api/client";
import type { SessionInfo } from "../api/types";

type SessionStatus = "loading" | "anonymous" | "authenticated";
type SessionContextValue = {
  status: SessionStatus;
  session?: SessionInfo;
  epoch: number;
  client: AdminClient;
  login(apiKey: string): Promise<void>;
  logout(): Promise<void>;
  invalidate(): void;
};

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [session, setSession] = useState<SessionInfo>();
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(0);
  const csrfRef = useRef<string | undefined>(undefined);
  const clientRef = useRef<AdminClient | undefined>(undefined);

  const invalidate = useCallback(() => {
    epochRef.current += 1;
    setEpoch(epochRef.current);
    csrfRef.current = undefined;
    setSession(undefined);
    setStatus("anonymous");
  }, []);

  if (!clientRef.current) {
    clientRef.current = createAdminClient({
      getCsrfToken: () => csrfRef.current,
      onUnauthorized: invalidate,
    });
  }
  const client = clientRef.current;

  useEffect(() => {
    const controller = new AbortController();
    const capturedEpoch = epochRef.current;
    void client.session(controller.signal).then((next) => {
      if (controller.signal.aborted || capturedEpoch !== epochRef.current) return;
      csrfRef.current = next.csrfToken;
      setSession(next);
      setStatus("authenticated");
    }).catch(() => {
      if (controller.signal.aborted || capturedEpoch !== epochRef.current) return;
      csrfRef.current = undefined;
      setSession(undefined);
      setStatus("anonymous");
    });
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    if (status !== "authenticated" || !session) return;
    const delay = Math.max(0, session.expiresAt - Date.now());
    const timer = window.setTimeout(invalidate, delay);
    return () => window.clearTimeout(timer);
  }, [invalidate, session, status]);

  const login = useCallback(async (apiKey: string) => {
    const capturedEpoch = epochRef.current;
    const next = await client.login(apiKey);
    if (capturedEpoch !== epochRef.current) return;
    csrfRef.current = next.csrfToken;
    setSession(next);
    setStatus("authenticated");
  }, [client]);

  const logout = useCallback(async () => {
    invalidate();
    try {
      await client.logout();
    } catch {
      // 本地立即匿名；界面由调用方提示服务端撤销未确认，后续再次登录会轮换旧会话。
    }
  }, [client, invalidate]);

  const value = useMemo<SessionContextValue>(() => ({
    status,
    ...(session ? { session } : {}),
    epoch,
    client,
    login,
    logout,
    invalidate,
  }), [client, epoch, invalidate, login, logout, session, status]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
