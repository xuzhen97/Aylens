export interface SearchRequest {
  query: string;
  route?: string | undefined;
  sources?: string[] | undefined;
  limit?: number | undefined;
  language?: string | undefined;
}

export interface SearchDocument {
  id: string;
  platform: string;
  type: string;
  url: string;
  canonicalUrl?: string | undefined;
  title?: string | undefined;
  text?: string | undefined;
  snippet?: string | undefined;
  publishedAt?: string | undefined;
  retrievedAt: string;
  score?: number | undefined;
  provenance: {
    provider: string;
    retrievalMethod: string;
    providerItemId?: string | undefined;
    requestId: string;
    fetchedAt: string;
    runtimeId?: string | undefined;
  };
  extensions?: Record<string, unknown> | undefined;
}

export interface ProviderExecutionMeta {
  status: "success" | "failed";
  runtimeId?: string | undefined;
  latencyMs: number;
  resultCount: number;
  error?: { code: string; message: string; retryable: boolean } | undefined;
}

export interface SearchResponse {
  requestId: string;
  traceId: string;
  status: "completed" | "partial" | "failed";
  items: SearchDocument[];
  meta: { providers: Record<string, ProviderExecutionMeta> };
}

export interface ProviderSearchResponse {
  items: SearchDocument[];
}
