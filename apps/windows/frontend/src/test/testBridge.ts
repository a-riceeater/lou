import type { ApprovalView, NativeEventName } from "@lou/protocol";
import { Emitter, type Bridge } from "../bridge/bridge";

type Handler = (body: any) => { status: number; body: unknown } | unknown;

/** Scriptable bridge for UI tests: route API calls and push server frames. */
export class TestBridge implements Bridge {
  readonly kind = "test" as const;
  readonly calls: Array<{ method: string; params: any }> = [];
  private readonly emitter = new Emitter();
  private readonly routes = new Map<string, Handler>();

  route(key: string, handler: Handler): this {
    this.routes.set(key, handler);
    return this;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === "api.request") {
      const key = `${params.method} ${String(params.path).split("?")[0]}`;
      const handler = this.routes.get(key);
      const result = handler ? handler(params.body) : { items: [] };
      const wrapped = result && typeof result === "object" && "status" in (result as object) ? result : { status: 200, body: result };
      return wrapped as T;
    }
    if (method === "app.info") return { version: "test", hotkey: "Alt+Space", connection: { state: "online", serverUrl: "http://x", deviceId: "dev_1" } } as T;
    return undefined as T;
  }

  on(event: NativeEventName, handler: (payload: unknown) => void): () => void {
    return this.emitter.on(event, handler);
  }

  emit(event: NativeEventName, payload: unknown): void {
    this.emitter.emit(event, payload);
  }

  server(type: string, payload: unknown, extra: Record<string, unknown> = {}): void {
    this.emit("server.message", { v: 1, id: `m_${Math.random()}`, ts: new Date().toISOString(), type, payload, ...extra });
  }

  apiCalls(path: string): any[] {
    return this.calls.filter((c) => c.method === "api.request" && String(c.params.path).startsWith(path)).map((c) => c.params);
  }
}

export function sampleApproval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: "apr_1",
    runId: "run_1",
    kind: "email.reply",
    title: "Reply to Sarah",
    summary: null,
    account: "me@example.com",
    fields: [
      { key: "to", label: "To", value: "sarah@example.com", editable: false, kind: "recipients" },
      { key: "subject", label: "Subject", value: "Re: Dinner tonight", editable: false, kind: "text" },
      { key: "body", label: "Message", value: "Sounds good. I'll be there around 6.", editable: true, kind: "longtext" },
    ],
    risk: "write",
    status: "pending",
    actionHash: "a".repeat(64),
    warnings: [],
    createdAt: new Date().toISOString(),
    expiresAt: null,
    error: null,
    ...overrides,
  };
}
