import type { NativeEventName, NativeMethod } from "@lou/protocol";

/**
 * The UI's only door to the outside world. In the Windows app this is the
 * WebView2 bridge to the trusted C# host (which holds the device credential and
 * the server connection). In a plain browser it is a development shim.
 */
export interface Bridge {
  readonly kind: "native" | "dev" | "test";
  request<T = unknown>(method: NativeMethod | "api.transcribe", params?: Record<string, unknown>): Promise<T>;
  on(event: NativeEventName, handler: (payload: unknown) => void): () => void;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

let current: Bridge | undefined;

export function setBridge(bridge: Bridge): void {
  current = bridge;
}

export function bridge(): Bridge {
  if (!current) throw new Error("Bridge not initialized");
  return current;
}

/** Tiny event emitter shared by bridge implementations. */
export class Emitter {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        h(payload);
      } catch (err) {
        console.error(`bridge handler for ${event} failed`, err);
      }
    }
  }
}

export function requestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
