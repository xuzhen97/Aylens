import { z } from "zod";

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  route: z.string().min(1).optional(),
  sources: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(100).optional(),
  language: z.string().min(1).optional(),
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

export const providerSearchResponseSchema = z.object({
  items: z.array(searchDocumentSchema),
});
