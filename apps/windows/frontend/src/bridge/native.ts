import { NativeEventSchema, NativeResponseSchema, type NativeEventName } from "@lou/protocol";
import { BridgeError, Emitter, requestId, type Bridge } from "./bridge";

interface WebView {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebView };
  }
}

const TIMEOUT_MS = 120_000;

/** WebView2 postMessage bridge to the C# host (DESKTOP_CLIENT.md §5). */
export class NativeBridge implements Bridge {
  readonly kind = "native" as const;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly emitter = new Emitter();

  constructor(private readonly webview: WebView) {
    webview.addEventListener("message", (e) => this.onMessage(e.data));
  }

  static available(): boolean {
    return typeof window !== "undefined" && !!window.chrome?.webview;
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = requestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", "The app didn't respond."));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.webview.postMessage({ type: "native.request", requestId: id, method, params });
    });
  }

  on(event: NativeEventName, handler: (payload: unknown) => void): () => void {
    return this.emitter.on(event, handler);
  }

  private onMessage(data: unknown): void {
    const msg = typeof data === "string" ? safeParse(data) : data;
    const response = NativeResponseSchema.safeParse(msg);
    if (response.success) {
      const p = this.pending.get(response.data.requestId);
      if (!p) return;
      this.pending.delete(response.data.requestId);
      clearTimeout(p.timer);
      if (response.data.success) p.resolve(response.data.result);
      else p.reject(new BridgeError(response.data.error?.code ?? "INTERNAL", response.data.error?.message ?? "Request failed.", response.data.error?.details));
      return;
    }
    const event = NativeEventSchema.safeParse(msg);
    if (event.success) this.emitter.emit(event.data.event, event.data.payload);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
