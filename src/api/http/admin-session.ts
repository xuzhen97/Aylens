import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_LOGIN_ENTRIES = 10_000;

export interface AdminSessionStoreOptions {
  getApiKey: () => string;
  now?: () => number;
  maxSessions?: number;
}

export interface AdminSession {
  id: string;
  expiresAt: number;
  csrfToken: string;
}

interface SessionRecord {
  expiresAt: number;
  csrfToken: string;
  apiKeyDigest: Buffer;
}

export interface LoginLimiterOptions {
  now?: () => number;
  maxEntries?: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AdminSessionCapacityError extends Error {
  constructor() {
    super("Admin session capacity reached");
    this.name = "AdminSessionCapacityError";
  }
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly getApiKey: () => string;
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: AdminSessionStoreOptions) {
    this.getApiKey = options.getApiKey;
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  create(previousId?: string): AdminSession {
    if (previousId) this.revoke(previousId);
    this.removeExpired();
    if (this.sessions.size >= this.maxSessions) throw new AdminSessionCapacityError();

    const id = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(digest(id).toString("hex"), {
      expiresAt,
      csrfToken,
      apiKeyDigest: digest(this.getApiKey()),
    });
    return { id, expiresAt, csrfToken };
  }

  get(id: string): Pick<AdminSession, "expiresAt" | "csrfToken"> | undefined {
    const key = digest(id).toString("hex");
    const record = this.sessions.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= this.now() || !safeEqual(record.apiKeyDigest, digest(this.getApiKey()))) {
      this.sessions.delete(key);
      return undefined;
    }
    return { expiresAt: record.expiresAt, csrfToken: record.csrfToken };
  }

  revoke(id: string): void {
    this.sessions.delete(digest(id).toString("hex"));
  }

  clear(): void {
    this.sessions.clear();
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(key);
    }
  }
}

interface LoginWindow {
  startedAt: number;
  attempts: number;
}

export class LoginLimiter {
  private readonly windows = new Map<string, LoginWindow>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: LoginLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_LOGIN_ENTRIES;
  }

  consume(ip: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const current = this.windows.get(ip);
    if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
      if (!current && this.windows.size >= this.maxEntries) {
        this.removeExpired(now);
        if (this.windows.size >= this.maxEntries) return { allowed: false, retryAfterSeconds: 300 };
      }
      this.windows.set(ip, { startedAt: now, attempts: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.attempts >= LOGIN_MAX_ATTEMPTS) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + LOGIN_WINDOW_MS - now) / 1000)),
      };
    }
    current.attempts += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private removeExpired(now: number): void {
    for (const [ip, window] of this.windows) {
      if (now - window.startedAt >= LOGIN_WINDOW_MS) this.windows.delete(ip);
    }
  }
}
