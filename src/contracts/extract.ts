import type { ProviderExecutionMeta, SearchDocument } from "./search.js";

/** 提取内容的格式与体量要求。markdown 与 text 沿用 SearchDocument 既有语义。 */
export interface ExtractContentRequest {
  format?: "markdown" | "text" | undefined;
  maxChars?: number | undefined;
}

/**
 * 独立的提取请求。sources 必填:第一期不默认并行调用所有提取服务。
 * providerOptions 按来源命名空间传入专属选项,由对应适配器严格校验。
 */
export interface ExtractRequest {
  urls: string[];
  sources: string[];
  limit?: number | undefined;
  content?: ExtractContentRequest | undefined;
  providerOptions?: Record<string, Record<string, unknown>> | undefined;
}

/** 逐项安全错误。message 由适配器本地生成,不携带上游原始文案。 */
export interface ExtractItemError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * 单个 URL 的提取结果,按输入索引关联。
 * 上游响应顺序不可信,不能用返回顺序推断输入对应关系。
 */
export interface ExtractItem {
  index: number;
  url: string;
  status: "success" | "failed";
  document?: SearchDocument | undefined;
  error?: ExtractItemError | undefined;
}

/** Provider 内部提取返回。 */
export interface ProviderExtractResponse {
  items: ExtractItem[];
}

export interface ExtractResponse {
  requestId: string;
  traceId: string;
  /** completed 仅在至少一项成功且无失败时成立;成功零项不得为 completed。 */
  status: "completed" | "partial" | "failed";
  items: ExtractItem[];
  meta: { providers: Record<string, ProviderExecutionMeta> };
}
