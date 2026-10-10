import type { SearchRequest } from "../contracts/search.js";
import { toSafeRequest } from "./safe-request.js";

/**
 * 审计记录的操作类型。缺省视为 search：
 * 既有记录没有该字段，读取时按 search 解释，新记录写入时显式标注。
 */
export type AuditOperation = "search" | "extract";

export interface AuditProviderEvent {
  providerId: string;
  runtimeId?: string;
  startedAt: number;
  completedAt: number;
  status: "success" | "failed";
  errorCode?: string;
  resultCount: number;
}

export interface AuditRecord {
  requestId: string;
  traceId: string;
  /** 缺省 = search（旧记录）。extract 记录显式标注，不靠 query 内容猜测。 */
  operation?: AuditOperation | undefined;
  request: SearchRequest;
  createdAt: number;
  completedAt?: number;
  status: "running" | "completed" | "partial" | "failed" | "interrupted";
  providers: AuditProviderEvent[];
}

/** 审计服务行为契约:内存实现与 SQLite 实现共用。 */
export interface AuditService {
  start(requestId: string, traceId: string, request: SearchRequest, operation?: AuditOperation): void;
  addProviderEvent(requestId: string, event: AuditProviderEvent): void;
  finish(requestId: string, status: AuditRecord["status"]): void;
  list(limit?: number): AuditRecord[];
  get(requestId: string): AuditRecord | undefined;
}

export class InMemoryAuditService implements AuditService {
  private readonly records = new Map<string, AuditRecord>();

  start(requestId: string, traceId: string, request: SearchRequest, operation?: AuditOperation): void {
    // 与 SQLite 实现共用同一脱敏契约：写入前就剥掉 URL 的 userinfo/query/fragment。
    // 否则内存实现会把未脱敏的查询直接暴露给 list()/get() 的读取方。
    this.records.set(requestId, {
      requestId,
      traceId,
      ...(operation !== undefined ? { operation } : {}),
      request: toSafeRequest(request),
      createdAt: Date.now(),
      status: "running",
      providers: [],
    });
  }

  addProviderEvent(requestId: string, event: AuditProviderEvent): void {
    const record = this.records.get(requestId);
    if (record) record.providers.push(event);
  }

  finish(requestId: string, status: AuditRecord["status"]): void {
    const record = this.records.get(requestId);
    if (!record) return;
    record.status = status;
    record.completedAt = Date.now();
  }

  list(limit = 50): AuditRecord[] {
    const safeLimit = Math.max(0, Math.min(Math.trunc(limit), 200));
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, safeLimit);
  }

  get(requestId: string): AuditRecord | undefined {
    return this.records.get(requestId);
  }
}
