import { DeviceRegisterResponseSchema, type ApiRequestParams, type ConnectionState, type NativeEventName } from "@lou/protocol";
import { BridgeError, Emitter, type Bridge } from "./bridge";

const STORAGE_KEY = "lou.dev.connection";

interface DevConfig {
  serverUrl: string;
  deviceToken: string;
  deviceId: string;
}

/**
 * Browser development bridge: lets the UI run under `vite dev` against a local
 * server without the C# host. The device token lives in localStorage, which is
 * acceptable only for development; the Windows app keeps it in the native host.
 */
export class DevBridge implements Bridge {
  readonly kind = "dev" as const;
  private readonly emitter = new Emitter();
  private socket: WebSocket | undefined;
  private lastSeq: number | undefined;
  private state: ConnectionState = { state: "unpaired", serverUrl: null, deviceId: null };
  private retry = 0;

  constructor() {
    const cfg = this.config();
    if (cfg) this.connect(cfg);
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case "api.request":
        return (await this.api(params as ApiRequestParams)) as T;
      case "api.transcribe":
        return (await this.transcribe(params as { audioBase64: string; mimeType: string })) as T;
      case "app.info":
        return { version: "dev", platform: "web", hotkey: "Alt+Space", connection: this.state } as T;
      case "pairing.complete":
        return (await this.pair(params as { serverUrl: string; pairingCode: string; name: string })) as T;
      case "pairing.reset":
        localStorage.removeItem(STORAGE_KEY);
        this.socket?.close();
        this.setState({ state: "unpaired", serverUrl: null, deviceId: null });
        return undefined as T;
      case "app.openExternal":
        window.open(String(params.url), "_blank", "noopener");
        return undefined as T;
      case "clipboard.write":
        await navigator.clipboard.writeText(String(params.text ?? ""));
        return undefined as T;
      case "window.hide":
      case "window.show":
      case "window.resize":
      case "settings.get":
      case "settings.set":
        return {} as T;
      default:
        throw new BridgeError("NOT_FOUND", `Unsupported method ${method}`);
    }
  }

  on(event: NativeEventName, handler: (payload: unknown) => void): () => void {
    if (event === "connection.state") queueMicrotask(() => handler(this.state));
    return this.emitter.on(event, handler);
  }

  private config(): DevConfig | undefined {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as DevConfig) : undefined;
    } catch {
      return undefined;
    }
  }

  private async api(params: ApiRequestParams): Promise<{ status: number; body: unknown }> {
    const cfg = this.config();
    if (!cfg) throw new BridgeError("UNAUTHORIZED", "This device isn't paired.");
    const res = await fetch(`${cfg.serverUrl}${params.path}`, {
      method: params.method,
      headers: { authorization: `Bearer ${cfg.deviceToken}`, ...(params.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    }).catch(() => {
      throw new BridgeError("OFFLINE", "Can't reach your server.");
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  private async transcribe(params: { audioBase64: string; mimeType: string }): Promise<{ text: string }> {
    const cfg = this.config();
    if (!cfg) throw new BridgeError("UNAUTHORIZED", "This device isn't paired.");
    const bytes = Uint8Array.from(atob(params.audioBase64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: params.mimeType }), "voice.webm");
    const res = await fetch(`${cfg.serverUrl}/api/transcribe`, { method: "POST", headers: { authorization: `Bearer ${cfg.deviceToken}` }, body: form });
    const body = await res.json();
    if (!res.ok) throw new BridgeError(body?.error?.code ?? "UPSTREAM_ERROR", body?.error?.message ?? "Transcription failed.");
    return body as { text: string };
  }

  private async pair(params: { serverUrl: string; pairingCode: string; name: string }): Promise<ConnectionState> {
    const serverUrl = params.serverUrl.replace(/\/$/, "");
    const res = await fetch(`${serverUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: params.pairingCode, name: params.name, platform: "web", capabilities: [] }),
    }).catch(() => {
      throw new BridgeError("OFFLINE", "Can't reach that server.");
    });
    const body = await res.json();
    if (!res.ok) throw new BridgeError(body?.error?.code ?? "UNAUTHORIZED", body?.error?.message ?? "Pairing failed.");
    const reg = DeviceRegisterResponseSchema.parse(body);
    const cfg = { serverUrl, deviceToken: reg.deviceToken, deviceId: reg.deviceId };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    this.connect(cfg);
    return this.state;
  }

  private connect(cfg: DevConfig): void {
    this.setState({ state: "connecting", serverUrl: cfg.serverUrl, deviceId: cfg.deviceId });
    const ws = new WebSocket(`${cfg.serverUrl.replace(/^http/, "ws")}/ws`, ["lou.v1", `bearer.${cfg.deviceToken}`]);
    this.socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, id: `h_${Date.now()}`, ts: new Date().toISOString(), type: "device.hello", payload: { platform: "web", clientVersion: "dev", capabilities: [], lastSeq: this.lastSeq } }));
    };
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      if (typeof frame.seq === "number") this.lastSeq = frame.seq;
      if (frame.type === "session.ready") {
        this.retry = 0;
        this.setState({ state: "online", serverUrl: cfg.serverUrl, deviceId: cfg.deviceId });
      }
      if (frame.type === "device.revoked") {
        localStorage.removeItem(STORAGE_KEY);
        this.setState({ state: "revoked", serverUrl: cfg.serverUrl, deviceId: cfg.deviceId });
      }
      this.emitter.emit("server.message", frame);
    };
    ws.onclose = () => {
      if (this.socket !== ws || this.state.state === "revoked" || !this.config()) return;
      this.setState({ state: "offline", serverUrl: cfg.serverUrl, deviceId: cfg.deviceId });
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.config() && this.connect(this.config()!), delay);
    };
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emitter.emit("connection.state", state);
  }
}
