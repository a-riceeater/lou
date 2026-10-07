import type {
  AiProvider,
  AccountView,
  ProviderStatus,
  ApprovalView,
  AuditEntry,
  ConnectAccountResponse,
  CreateRunResponse,
  DeviceView,
  GoogleSetupStatus,
  HistoryItem,
  MemoryType,
  MemoryView,
  NotificationView,
  PairingCodeResponse,
  ProposalView,
  RunView,
  SettingsView,
  SkillDetail,
  SkillSummary,
  SpotifyPlayerActionRequest,
  SpotifyPlayerView,
  SpotifyStatus,
  WorkflowSummary,
} from "@lou/protocol";
import { bridge, BridgeError } from "../bridge/bridge";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** Typed server API. Requests go through the native host, which attaches credentials. */
async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await bridge().request<{ status: number; body: any }>("api.request", { method, path, ...(body !== undefined ? { body } : {}) });
  if (res.status >= 400) {
    const err = res.body?.error;
    throw new BridgeError(err?.code ?? "INTERNAL", err?.message ?? `Request failed (${res.status}).`, { status: res.status });
  }
  return res.body as T;
}

export const api = {
  startRun: (text: string, conversationId?: string, inputMode: "text" | "voice" = "text", provider?: AiProvider) =>
    call<CreateRunResponse>("POST", "/api/runs", { text, conversationId, inputMode, ...(provider ? { provider } : {}) }),
  run: (id: string) => call<RunView>("GET", `/api/runs/${id}`),
  cancelRun: (id: string) => call<{ ok: true }>("POST", `/api/runs/${id}/cancel`),
  history: () => call<{ items: HistoryItem[] }>("GET", "/api/history?limit=100").then((r) => r.items),

  approvals: (status?: string) => call<{ items: ApprovalView[] }>("GET", `/api/approvals${status ? `?status=${status}` : ""}`).then((r) => r.items),
  approval: (id: string) => call<ApprovalView>("GET", `/api/approvals/${id}`),
  resolveApproval: (id: string, decision: "approve" | "reject", actionHash: string, edits?: Record<string, string>) =>
    call<ApprovalView>("POST", `/api/approvals/${id}/resolve`, { decision, actionHash, ...(edits && Object.keys(edits).length ? { edits } : {}) }),

  accounts: () => call<{ items: AccountView[]; available: { google: boolean; instagram: boolean; spotify?: boolean } }>("GET", "/api/accounts"),
  connectAccount: (provider: "google" | "instagram" | "spotify") => call<ConnectAccountResponse>("POST", `/api/accounts/${provider}/connect`),
  checkAccount: (id: string) => call<AccountView>("POST", `/api/accounts/${id}/check`),
  disconnectAccount: (id: string) => call<{ ok: true }>("DELETE", `/api/accounts/${id}`),

  createGmailScript: (resetId?: string) => call<{ accountId: string; script: string }>("POST", resetId ? `/api/accounts/${resetId}/appscript/reset` : "/api/accounts/google/appscript"),

  googleSetup: () => call<GoogleSetupStatus>("GET", "/api/google"),
  saveGoogleApp: (clientId: string, clientSecret: string) => call<GoogleSetupStatus>("POST", "/api/google/app", { clientId, clientSecret }),

  spotify: () => call<SpotifyStatus>("GET", "/api/spotify"),
  saveSpotifyApp: (clientId: string, clientSecret: string) => call<SpotifyStatus>("POST", "/api/spotify/app", { clientId, clientSecret }),
  spotifyPlayer: () => call<SpotifyPlayerView>("GET", "/api/spotify/player"),
  spotifyControl: (action: SpotifyPlayerActionRequest["action"], volumePercent?: number) =>
    call<{ ok: true }>("POST", "/api/spotify/player", { action, ...(volumePercent === undefined ? {} : { volumePercent }) }),

  devices: () => call<{ items: DeviceView[] }>("GET", "/api/devices").then((r) => r.items),
  pairingCode: () => call<PairingCodeResponse>("POST", "/api/devices/pairing-codes"),
  revokeDevice: (id: string) => call<{ ok: true }>("POST", `/api/devices/${id}/revoke`),

  skills: () => call<{ items: SkillSummary[] }>("GET", "/api/skills").then((r) => r.items),
  skill: (id: string) => call<SkillDetail>("GET", `/api/skills/${id}`),
  setSkillEnabled: (id: string, enabled: boolean) => call<SkillDetail>("POST", `/api/skills/${id}/enable`, { enabled }),
  rollbackSkill: (id: string, version: number) => call<SkillDetail>("POST", `/api/skills/${id}/rollback`, { version }),
  workflows: () => call<{ items: WorkflowSummary[] }>("GET", "/api/workflows").then((r) => r.items),

  memories: () => call<{ items: MemoryView[] }>("GET", "/api/memories").then((r) => r.items),
  addMemory: (type: MemoryType, content: string) => call<MemoryView>("POST", "/api/memories", { type, content }),
  updateMemory: (id: string, patch: { content?: string; status?: "active" }) => call<MemoryView>("PATCH", `/api/memories/${id}`, patch),
  deleteMemory: (id: string) => call<{ ok: true }>("DELETE", `/api/memories/${id}`),

  proposals: () => call<{ items: ProposalView[] }>("GET", "/api/proposals?status=pending").then((r) => r.items),
  resolveProposal: (id: string, accept: boolean) => call<{ ok: true }>("POST", `/api/proposals/${id}/resolve`, { accept }),

  notifications: () => call<{ items: NotificationView[] }>("GET", "/api/notifications").then((r) => r.items),
  markNotification: (id: string, action: "read" | "dismiss") => call<{ ok: true }>("POST", `/api/notifications/${id}/${action}`),

  audit: (runId?: string) => call<{ items: AuditEntry[] }>("GET", `/api/audit?limit=200${runId ? `&runId=${runId}` : ""}`).then((r) => r.items),
  settings: () => call<SettingsView>("GET", "/api/settings"),
  providers: (probe = false) => call<{ active: AiProvider; items: ProviderStatus[] }>("GET", `/api/providers${probe ? "?probe=1" : ""}`),
  updateSettings: (patch: Partial<SettingsView>) => call<SettingsView>("PATCH", "/api/settings", patch),

  transcribe: (audioBase64: string, mimeType: string) => bridge().request<{ text: string }>("api.transcribe", { audioBase64, mimeType }),
};

/** Turns error codes into short, actionable copy (DESIGN.md §9). */
export interface FriendlyError {
  message: string;
  action?: "reconnect" | "retry" | "settings";
  detail?: string;
  /** Another provider the user may explicitly retry with (never applied automatically). */
  fallbackProvider?: AiProvider;
}

/** Pairing never means "signed out": show why the server refused, or why it couldn't be reached. */
export function pairingErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if ((e.code === "UNAUTHORIZED" || e.code === "PAIRING_REJECTED") && e.message) return e.message;
  return friendlyError(err).message;
}

export function friendlyError(err: unknown): FriendlyError {
  const e = err as { code?: string; message?: string; details?: { fallbackProvider?: AiProvider } };
  const fallbackProvider = e.details?.fallbackProvider;
  if (fallbackProvider) return { message: e.message ?? "The assistant couldn't finish that.", action: e.code === "NOT_CONFIGURED" ? "settings" : "retry", detail: e.code, fallbackProvider };
  switch (e.code) {
    case "AUTH_REQUIRED":
      return { message: e.message ?? "An account needs you to sign in again.", action: "reconnect" };
    case "NOT_CONFIGURED":
      return { message: e.message ?? "This isn't set up on your server yet.", action: "settings" };
    case "OFFLINE":
    case "DEVICE_OFFLINE":
      return { message: "Can't reach your server right now.", action: "retry", detail: e.message };
    case "RATE_LIMITED":
      return { message: "Too many requests. Try again in a moment.", action: "retry" };
    case "POLICY_DENIED":
      return { message: e.message ?? "That action is turned off.", action: "settings" };
    case "UNAUTHORIZED":
      return { message: "This device was signed out. Pair it again." };
    default:
      return { message: e.message ?? "Something went wrong.", action: "retry", detail: e.code };
  }
}
