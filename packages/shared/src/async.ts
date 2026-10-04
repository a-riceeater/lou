import { LouError } from "./errors";

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LouError("CANCELLED", "The operation was cancelled.");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LouError("CANCELLED", "The operation was cancelled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LouError("CANCELLED", "The operation was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}
