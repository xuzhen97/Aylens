import type { AdminOverview, ApiError, ProviderAuthResponse, SearchRequest, SearchResponse, SessionInfo } from "./types";
import type { ProxyWrite, SafeProxyConfig } from "./proxy-types";

type ClientOptions = {
  fetchImpl?: typeof fetch;
  getCsrfToken: () => string | undefined;
  onUnauthorized: () => void;
};

export type AdminClient = ReturnType<typeof createAdminClient>;

type ErrorPayload = { error?: { code?: unknown; message?: unknown } };

export function createAdminClient(options: ClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}, includeCsrf = false): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (includeCsrf) {
      const token = options.getCsrfToken();
      if (token) headers.set("x-csrf-token", token);
    }
    const response = await fetchImpl(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });

    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      let payload: ErrorPayload | undefined;
      try {
        payload = await response.json() as ErrorPayload;
      } catch {
        payload = undefined;
      }
      const error = new Error(
        typeof payload?.error?.message === "string" ? payload.error.message : `Request failed (${response.status})`,
      ) as ApiError;
      error.status = response.status;
      error.code = typeof payload?.error?.code === "string" ? payload.error.code : "REQUEST_FAILED";
      if (response.status === 401) options.onUnauthorized();
      if (response.status === 429) {
        const retry = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retry)) error.retryAfterSeconds = retry;
      }
      throw error;
    }
    return await response.json() as T;
  }

  return {
    login(apiKey: string, signal?: AbortSignal): Promise<SessionInfo> {
      return request("/v1/admin/session/login", {
        method: "POST",
        body: JSON.stringify({ apiKey }),
        ...(signal ? { signal } : {}),
      });
    },
    session(signal?: AbortSignal): Promise<SessionInfo> {
      return request("/v1/admin/session", { ...(signal ? { signal } : {}) });
    },
    logout(signal?: AbortSignal): Promise<void> {
      return request("/v1/admin/session/logout", {
        method: "POST",
        ...(signal ? { signal } : {}),
      }, true);
    },
    overview(signal?: AbortSignal): Promise<AdminOverview> {
      return request("/v1/admin/overview", { ...(signal ? { signal } : {}) });
    },
    search(input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
      return request("/v1/search", {
        method: "POST",
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      }, true);
    },
    providerAuth(providerId: string, action: "login" | "check", signal?: AbortSignal): Promise<ProviderAuthResponse> {
      return request(`/v1/providers/${encodeURIComponent(providerId)}/auth/${action}`, {
        method: "POST",
        ...(signal ? { signal } : {}),
      }, true);
    },
    proxyConfig(runnerId: string, signal?: AbortSignal): Promise<SafeProxyConfig> {
      return request(`/v1/admin/runners/${encodeURIComponent(runnerId)}/proxy-config`, {
        ...(signal ? { signal } : {}),
      });
    },
    writeProxyConfig(runnerId: string, write: ProxyWrite, signal?: AbortSignal): Promise<SafeProxyConfig> {
      return request(`/v1/admin/runners/${encodeURIComponent(runnerId)}/proxy-config`, {
        method: "POST",
        body: JSON.stringify(write),
        ...(signal ? { signal } : {}),
      }, true);
    },
  };
}
