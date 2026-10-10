import { z } from "zod";

export const providerAuthStateSchema = z.object({
  status: z.enum(["unknown", "authenticated", "auth_required"]),
  account: z.object({
    handle: z.string().min(1),
    displayName: z.string().min(1).optional(),
  }).optional(),
  checkedAt: z.number().int().nonnegative(),
});

/** 服务商专属选项:按 Provider ID 分命名空间,由对应适配器严格校验。 */
export const providerOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

/**
 * 搜索时是否顺带正文。既有调用不带该字段 → 不自动请求全文,不隐式增加费用。
 * 适配器原生支持时才在同一次调用里返回正文,不额外发 Extract 请求。
 */
export const searchContentSchema = z.object({
  mode: z.enum(["none", "summary", "full"]),
  format: z.enum(["markdown", "text"]).optional(),
  maxChars: z.number().int().positive().max(2_000_000).optional(),
});

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  route: z.string().min(1).optional(),
  sources: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(100).optional(),
  language: z.string().min(1).optional(),
  content: searchContentSchema.optional(),
  providerOptions: providerOptionsSchema.optional(),
});

const absoluteHttpUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export const extractContentRequestSchema = z.object({
  format: z.enum(["markdown", "text"]).optional(),
  maxChars: z.number().int().positive().max(2_000_000).optional(),
});

/**
 * Extract 是独立于 Search 的能力:必须显式给出来源,不默认并行调用所有提取服务。
 * urls 上限与公共资源上限对齐(见 Spec §4.2),具体原生批次限制由适配器再拆分。
 */
export const extractRequestSchema = z.object({
  urls: z.array(z.string().min(1)).min(1).max(100)
    .refine((urls) => urls.every(absoluteHttpUrl), {
      message: "Extract urls must be absolute http(s) urls",
    }),
  sources: z.array(z.string().min(1)).min(1),
  limit: z.number().int().positive().max(100).optional(),
  content: extractContentRequestSchema.optional(),
  providerOptions: providerOptionsSchema.optional(),
});

export const searchDocumentSchema = z.object({
  id: z.string(),
  platform: z.string(),
  type: z.string(),
  url: z.string(),
  canonicalUrl: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  snippet: z.string().optional(),
  markdown: z.string().optional(),
  publishedAt: z.string().optional(),
  retrievedAt: z.string(),
  score: z.number().optional(),
  provenance: z.object({
    provider: z.string(),
    retrievalMethod: z.string(),
    providerItemId: z.string().optional(),
    requestId: z.string(),
    fetchedAt: z.string(),
    runtimeId: z.string().optional(),
  }),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const providerExecutionMetaSchema = z.object({
  status: z.enum(["success", "failed"]),
  runtimeId: z.string().optional(),
  latencyMs: z.number(),
  resultCount: z.number(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
});

export const providerSearchResponseSchema = z.object({
  items: z.array(searchDocumentSchema),
});
