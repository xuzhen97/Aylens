export const RETRIEVAL_ERROR_CODES = [
  "INVALID_REQUEST",
  "AUTH_FAILED",
  "PROVIDER_DISABLED",
  "PROVIDER_UNAVAILABLE",
  "NO_COMPATIBLE_RUNTIME",
  "RUNTIME_OFFLINE",
  "RUNNER_LOST",
  "PROFILE_BUSY",
  "PROFILE_AUTH_REQUIRED",
  "BROWSER_START_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "PROXY_FAILED",
  "NETWORK_POLICY_REJECTED",
  "UPSTREAM_AUTH_FAILED",
  "UPSTREAM_ERROR",
  "PARSE_ERROR",
  "BLOCKED",
  "URL_FORBIDDEN",
  "CONTENT_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type RetrievalErrorCode = typeof RETRIEVAL_ERROR_CODES[number];

const retrievalErrorCodeSet = new Set<string>(RETRIEVAL_ERROR_CODES);

export function isRetrievalErrorCode(value: string): value is RetrievalErrorCode {
  return retrievalErrorCodeSet.has(value);
}

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: RetrievalErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RetrievalError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toErrorPayload(error: unknown): {
  code: RetrievalErrorCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof RetrievalError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
    };

    if (
      typeof candidate.code === "string" &&
      isRetrievalErrorCode(candidate.code) &&
      typeof candidate.message === "string"
    ) {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
      };
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown error",
    retryable: false,
  };
}
