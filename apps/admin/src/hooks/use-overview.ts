import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AdminOverview } from "../api/types";
import { useSession } from "../auth/session-context";

type OverviewValue = {
  data?: AdminOverview;
  loading: boolean;
  error?: string;
  autoRefresh: boolean;
  setAutoRefresh(value: boolean): void;
  refresh(): Promise<void>;
};

const OverviewContext = createContext<OverviewValue | undefined>(undefined);

export function OverviewProvider({ children }: { children: ReactNode }) {
  const { client, epoch, status } = useSession();
  const [data, setData] = useState<AdminOverview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const epochRef = useRef(epoch);
  epochRef.current = epoch;

  const refresh = useCallback(async () => {
    if (status !== "authenticated" || inFlight.current) return;
    inFlight.current = true;
    const capturedEpoch = epochRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const next = await client.overview(controller.signal);
      if (!controller.signal.aborted && capturedEpoch === epochRef.current) {
        setData(next);
        setError(undefined);
      }
    } catch (cause) {
      if (!controller.signal.aborted && capturedEpoch === epochRef.current) {
        setError(cause instanceof Error ? cause.message : "刷新失败");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        inFlight.current = false;
        if (capturedEpoch === epochRef.current) setLoading(false);
      }
    }
  }, [client, status]);

  useEffect(() => {
    if (status !== "authenticated") {
      abortRef.current?.abort();
      abortRef.current = undefined;
      inFlight.current = false;
      setData(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    void refresh();
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [autoRefresh, epoch, refresh, status]);

  const value = useMemo<OverviewValue>(() => ({
    ...(data ? { data } : {}), loading, ...(error ? { error } : {}), autoRefresh, setAutoRefresh, refresh,
  }), [autoRefresh, data, error, loading, refresh]);
  return createElement(OverviewContext.Provider, { value }, children);
}

export function useOverview(): OverviewValue {
  const value = useContext(OverviewContext);
  if (!value) throw new Error("useOverview must be used inside OverviewProvider");
  return value;
}
