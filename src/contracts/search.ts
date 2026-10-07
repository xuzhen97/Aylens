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
  /**
   * 文档的 Markdown 内容。只有能提供结构化正文的 Provider（如 url-fetch）才填充；
   * text 与 snippet 保持纯文本语义不变。Markdown 是非可信文档内容，不是安全 HTML。
   */
  markdown?: string | undefined;
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
