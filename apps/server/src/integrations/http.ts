import { LouError } from "@lou/shared";

export type FetchLike = typeof fetch;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  json?: unknown;
  signal?: AbortSignal;
  /** Provider name for error messages, e.g. "Gmail". */
  service: string;
}

/**
 * JSON fetch with structured, user-friendly errors. 401 → AUTH_REQUIRED (caller
 * may refresh), 429 → RATE_LIMITED, 5xx → UPSTREAM_ERROR (retryable).
 */
export async function fetchJson<T>(fetchImpl: FetchLike, url: string, options: HttpOptions): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  let body: string | URLSearchParams | undefined = options.body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { method: options.method ?? (body ? "POST" : "GET"), headers, body, signal: options.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new LouError("CANCELLED", "Cancelled.");
    throw new LouError("UPSTREAM_ERROR", `${options.service} could not be reached.`, { cause: err });
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = extractMessage(data) ?? res.statusText;
    if (res.status === 401) throw new LouError("AUTH_REQUIRED", `${options.service} needs you to sign in again.`, { details: { status: res.status, detail } });
    if (res.status === 403) throw new LouError("FORBIDDEN", `${options.service} refused the request: ${detail}`, { details: { status: res.status } });
    if (res.status === 404) throw new LouError("NOT_FOUND", `${options.service}: not found.`, { details: { status: res.status, detail } });
    if (res.status === 429) throw new LouError("RATE_LIMITED", `${options.service} is rate limiting requests. Try again shortly.`);
    if (res.status >= 500) throw new LouError("UPSTREAM_ERROR", `${options.service} is having trouble right now.`, { details: { status: res.status } });
    throw new LouError("UPSTREAM_ERROR", `${options.service} error: ${detail}`, { retryable: false, details: { status: res.status, body: data } });
  }
  return data as T;
}

function extractMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return typeof data === "string" ? data.slice(0, 200) : undefined;
  const d = data as Record<string, any>;
  return d.error?.message ?? d.error_description ?? (typeof d.error === "string" ? d.error : undefined) ?? d.message;
}
