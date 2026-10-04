/**
 * Structured error codes shared by the server, agent runtime, tools and clients.
 * Clients map these to friendly copy; developer details stay expandable.
 */
export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_MISMATCH",
  "APPROVAL_EXPIRED",
  "USER_REJECTED",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "DEVICE_OFFLINE",
  "TIMEOUT",
  "CANCELLED",
  "NOT_CONFIGURED",
  "MODEL_ERROR",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes that are worth retrying automatically without user involvement. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["RATE_LIMITED", "UPSTREAM_ERROR", "TIMEOUT"]);

export interface SerializedError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class LouError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LouError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    if (options.details) this.details = options.details;
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isLouError(value: unknown): value is LouError {
  return value instanceof LouError;
}

/** Normalizes anything thrown into a LouError without leaking stack traces to callers. */
export function toLouError(value: unknown, fallback: ErrorCode = "INTERNAL"): LouError {
  if (value instanceof LouError) return value;
  if (value instanceof Error && value.name === "AbortError") {
    return new LouError("CANCELLED", "The operation was cancelled.", { cause: value });
  }
  const message = value instanceof Error ? value.message : String(value);
  return new LouError(fallback, message, { cause: value });
}
