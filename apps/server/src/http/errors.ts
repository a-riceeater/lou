import { isLouError, type ErrorCode } from "@lou/shared";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  APPROVAL_MISMATCH: 409,
  APPROVAL_EXPIRED: 410,
  DEVICE_OFFLINE: 409,
  AUTH_REQUIRED: 424,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
};

/** Maps structured errors to HTTP responses without leaking stack traces. */
export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (isLouError(error)) {
    const status = STATUS[error.code] ?? 500;
    if (status >= 500) request.log.error({ code: error.code, err: error.message }, "request failed");
    void reply.status(status).send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    return;
  }
  if (error instanceof ZodError) {
    void reply.status(400).send({ error: { code: "VALIDATION_FAILED", message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), retryable: false } });
    return;
  }
  const fe = error as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    void reply.status(fe.statusCode).send({ error: { code: fe.statusCode === 429 ? "RATE_LIMITED" : "VALIDATION_FAILED", message: fe.message, retryable: fe.statusCode === 429 } });
    return;
  }
  request.log.error({ err: error }, "unhandled error");
  void reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong on the server.", retryable: false } });
}
