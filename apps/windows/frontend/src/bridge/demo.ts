import type { ApprovalView, NativeEventName } from "@lou/protocol";
import { Emitter, type Bridge } from "./bridge";

/**
 * Design-preview bridge with fixture data, used only in `vite --mode demo`
 * builds (never in the Windows app). `#/palette?state=approval|thinking|answer`
 * jumps straight to a palette state for visual review.
 */
const approval: ApprovalView = {
  id: "apr_demo",
  runId: "run_demo",
  kind: "email.reply",
  title: "Reply to Sarah",
  summary: null,
  account: "alex@example.com",
  fields: [
    { key: "to", label: "To", value: "sarah.lee@example.com", editable: false, kind: "recipients" },
    { key: "subject", label: "Subject", value: "Re: Dinner tonight?", editable: false, kind: "text" },
    { key: "body", label: "Message", value: "Sounds good! I'll be there around 6.", editable: true, kind: "longtext" },
  ],
  risk: "write",
  status: "pending",
  actionHash: "0".repeat(64),
  warnings: [],
  createdAt: new Date().toISOString(),
  expiresAt: null,
  error: null,
};

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const fixtures: Record<string, unknown> = {
  "GET /api/approvals": { items: [] },
  "GET /api/history": {
    items: [
      { runId: "r1", request: "Reply to the latest email from Sarah and tell her I'll be there around 6", status: "completed", summary: "Sent your reply to Sarah.", outcome: "action_taken", createdAt: ago(3) },
      { runId: "r2", request: "What did Mr. Smith want?", status: "completed", summary: "He's asking whether you can attend the robotics meeting on Friday.", outcome: "answered", createdAt: ago(48) },
      { runId: "r3", request: "Open my budget spreadsheet", status: "completed", summary: "Opened Robotics Budget 2026.xlsx.", outcome: "action_taken", createdAt: ago(190) },
      { runId: "r4", request: "Email the club about Saturday", status: "completed", summary: "Okay, I cancelled that.", outcome: "cancelled", createdAt: ago(1500) },
    ],
  },
  "GET /api/notifications": {
    items: [
      { id: "n1", title: "Mr. Smith", body: "Asking whether you can attend Friday's robotics meeting.", source: "gmail", category: "school", importance: 0.86, status: "unread", actions: [{ id: "reply", label: "Reply", kind: "reply", value: "Reply to Mr. Smith" }], createdAt: ago(12) },
      { id: "n2", title: "@maya.designs", body: "Wants to know if the poster files are ready.", source: "instagram", category: "social", importance: 0.72, status: "read", actions: [], createdAt: ago(95) },
    ],
  },
  "GET /api/skills": {
    items: [
      { id: "reply-to-email", name: "reply-to-email", description: "Find a specific email and reply in your voice, with an editable approval before sending.", version: 1, risk: "write", enabled: true, origin: "builtin", tools: [], updatedAt: ago(4000) },
      { id: "reply-club-inquiry", name: "reply-club-inquiry", description: "Reply to the newest club inquiry in the club's friendly tone.", version: 2, risk: "write", enabled: true, origin: "agent", tools: [], updatedAt: ago(600) },
      { id: "triage-inbox", name: "triage-inbox", description: "Summarize recent unread email and point out what needs a response.", version: 1, risk: "read", enabled: false, origin: "builtin", tools: [], updatedAt: ago(4000) },
    ],
  },
  "GET /api/proposals": { items: [] },
  "GET /api/accounts": {
    items: [
      { id: "a1", provider: "google", displayName: "Alex", address: "alex@example.com", status: "connected", capabilities: [], lastCheckedAt: ago(2), lastError: null },
      { id: "a2", provider: "google", displayName: "Alex (school)", address: "alex@school.edu", status: "needs_reauth", capabilities: [], lastCheckedAt: ago(30), lastError: null },
      { id: "a3", provider: "mcp", displayName: "Zapier", address: "https://mcp.zapier.com", status: "connected", capabilities: [], lastCheckedAt: ago(5), lastError: null },
    ],
    available: { google: true, instagram: true, spotify: true },
  },
  "GET /api/devices": {
    items: [
      { id: "d1", name: "Alex's PC", platform: "windows", status: "active", online: true, capabilities: ["open_app", "search_files", "clipboard_read", "notifications"], lastSeenAt: ago(0), createdAt: ago(9000), current: true },
      { id: "d2", name: "Laptop", platform: "windows", status: "active", online: false, capabilities: ["open_app"], lastSeenAt: ago(300), createdAt: ago(8000), current: false },
    ],
  },
  "GET /api/memories": {
    items: [
      { id: "m1", type: "preference", content: "Keep replies short and friendly.", source: "user", confidence: 1, status: "active", createdAt: ago(900), updatedAt: ago(900), expiresAt: null },
      { id: "m2", type: "account_mapping", content: "Use alex@school.edu for anything about the robotics club.", source: "user", confidence: 1, status: "active", createdAt: ago(800), updatedAt: ago(800), expiresAt: null },
      { id: "m3", type: "contact", content: "Sarah Lee is my chemistry lab partner.", source: "agent-inferred", confidence: 0.6, status: "active", createdAt: ago(60), updatedAt: ago(60), expiresAt: null },
    ],
  },
  "GET /api/spotify": {
    state: "connected",
    configSource: "server",
    clientId: "0123456789abcdef0123456789abcdef",
    redirectUri: "https://lou.example.com/oauth/spotify/callback",
    scopes: ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "playlist-read-private"],
    account: { id: "a4", displayName: "Alex", spotifyUserId: "alex" },
    lastError: null,
  },
  "GET /api/spotify/player": {
    active: true,
    isPlaying: true,
    item: { type: "track", name: "Pink Pony Club", artists: ["Chappell Roan"], album: "The Rise and Fall of a Midwest Princess", imageUrl: null, url: "https://open.spotify.com/", durationMs: 258_000 },
    progressMs: 61_000,
    fetchedAt: new Date().toISOString(),
    device: { id: "s1", name: "DESKTOP-ALEX", type: "Computer", isActive: true, isRestricted: false, volumePercent: 60, supportsVolume: true },
    shuffle: false,
    repeat: "off",
  },
  "GET /api/settings": { writeToolsDisabled: false, deviceControlDisabled: false, monitoringDisabled: false, agentPaused: false, autoActivateLowRiskSkills: false, aiProvider: "codex_cli" },
  "GET /api/providers": {
    active: "codex_cli",
    items: [
      { id: "openai_api", label: "OpenAI API", active: false, state: "not_configured", summary: "Not set up", hint: "Set OPENAI_API_KEY on the server.", details: { Model: "gpt-6-luna", Authentication: "none" } },
      { id: "codex_cli", label: "Codex CLI", active: true, state: "ready", summary: "Connected", hint: null, details: { CLI: "installed (0.151.0)", Status: "connected", Authentication: "ChatGPT (plus)", Sandbox: "locked down: Lou tools only" } },
    ],
  },
};

export class DemoBridge implements Bridge {
  readonly kind = "dev" as const;
  private readonly emitter = new Emitter();

  constructor() {
    const state = new URLSearchParams(location.hash.split("?")[1] ?? "").get("state");
    setTimeout(() => {
      if (state === "approval") this.push("approval.requested", { approval });
      if (state === "thinking" || state === "answer") {
        void this.request("api.request", { method: "POST", path: "/api/runs", body: { text: "x" } });
      }
    }, 50);
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === "app.info") return { version: "0.1.0", hotkey: "Alt+Space", connection: { state: "online", serverUrl: "https://lou.example.com", deviceId: "d1" } } as T;
    if (method !== "api.request") return {} as T;
    const key = `${params.method} ${String(params.path).split("?")[0]}`;
    if (key === "POST /api/runs") {
      const state = new URLSearchParams(location.hash.split("?")[1] ?? "").get("state");
      setTimeout(() => this.push("agent.progress", { runId: "run_demo", status: "waiting_for_tool", label: "Searching email" }), 30);
      if (state !== "thinking") {
        setTimeout(() => (state === "answer" ? this.push("agent.completed", { runId: "run_demo", status: "completed", message: "Mr. Smith is asking whether you can attend Friday's robotics meeting at 4 PM. He'd like an answer by Thursday.", error: null }) : this.push("approval.requested", { approval })), 120);
      }
      return { status: 202, body: { runId: "run_demo", conversationId: "c1" } } as T;
    }
    if (key.startsWith("GET /api/runs/")) return { status: 200, body: { id: "run_demo", status: "reasoning", approvalId: null } } as T;
    return { status: 200, body: fixtures[key] ?? { items: [] } } as T;
  }

  on(event: NativeEventName, handler: (payload: unknown) => void): () => void {
    return this.emitter.on(event, handler);
  }

  private push(type: string, payload: unknown): void {
    this.emitter.emit("server.message", { v: 1, id: `m${Math.random()}`, ts: new Date().toISOString(), type, payload });
  }
}
