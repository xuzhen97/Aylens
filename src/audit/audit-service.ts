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
  status: "running" | "completed" | "partial" | "failed";
  providers: AuditProviderEvent[];
}

export class InMemoryAuditService {
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

  get(requestId: string): AuditRecord | undefined {
    return this.records.get(requestId);
  }
}
