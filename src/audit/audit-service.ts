import type { SearchRequest } from "../contracts/search.js";

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
  request: SearchRequest;
  createdAt: number;
  completedAt?: number;
  status: "running" | "completed" | "partial" | "failed" | "interrupted";
  providers: AuditProviderEvent[];
}

/** 审计服务行为契约:内存实现与 SQLite 实现共用。 */
export interface AuditService {
  start(requestId: string, traceId: string, request: SearchRequest): void;
  addProviderEvent(requestId: string, event: AuditProviderEvent): void;
  finish(requestId: string, status: AuditRecord["status"]): void;
  list(limit?: number): AuditRecord[];
  get(requestId: string): AuditRecord | undefined;
}

export class InMemoryAuditService implements AuditService {
  private readonly records = new Map<string, AuditRecord>();

  start(requestId: string, traceId: string, request: SearchRequest): void {
    this.records.set(requestId, {
      requestId,
      traceId,
      request,
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
