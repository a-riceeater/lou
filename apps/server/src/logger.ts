import pino, { type Logger } from "pino";

/**
 * Structured logging. Secrets are redacted by path so tokens never reach logs
 * even if a handler accidentally logs a whole object.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.accessToken",
  "*.refreshToken",
  "*.access_token",
  "*.refresh_token",
  "*.deviceToken",
  "*.commandKey",
  "*.clientSecret",
  "*.client_secret",
  "*.password",
  "*.apiKey",
];

/** Strips query strings (OAuth codes, states) from logged URLs. */
export function safeUrl(url: string | undefined): string | undefined {
  return url?.split("?")[0];
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "lou-server" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" } } } : {}),
  });
}

export type { Logger };
