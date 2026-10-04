import type { SerializedError } from "./errors";

/** Uniform tool/operation result. Tools never throw across the runtime boundary. */
export type Result<T> = { success: true; data: T } | { success: false; error: SerializedError };

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function fail<T = never>(error: SerializedError): Result<T> {
  return { success: false, error };
}
