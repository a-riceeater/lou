import type { AiProvider, ApprovalView, ServerMessage } from "@lou/protocol";
import { create } from "zustand";
import { api, friendlyError, type FriendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";

export type Phase = "idle" | "listening" | "transcribing" | "thinking" | "tool" | "approval" | "sending" | "success" | "failure";

export interface PaletteStore {
  phase: Phase;
  text: string;
  /** Short user-facing status, e.g. "Searching email". */
  label: string;
  runId: string | null;
  conversationId: string | null;
  conversationAt: number;
  approval: ApprovalView | null;
  /** Current values of editable approval fields. */
  draft: Record<string, string>;
  message: string | null;
  error: FriendlyError | null;
  /** Assistant text streamed so far for the current run. */
  stream: string;
  /** The last request, kept so the user can explicitly retry with another provider. */
  lastRequest: string | null;

  setText(text: string): void;
  submit(inputMode?: "text" | "voice", provider?: AiProvider): Promise<void>;
  retryWith(provider: AiProvider): Promise<void>;
  setDraft(key: string, value: string): void;
  approve(): Promise<void>;
  reject(): Promise<void>;
  showApproval(approval: ApprovalView): void;
  onServerMessage(frame: ServerMessage): void;
  setListening(listening: boolean): void;
  transcribed(text: string): Promise<void>;
  fail(err: unknown): void;
  reset(): void;
}

const CONVERSATION_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

export const usePalette = create<PaletteStore>((set, get) => {
  /** Poll as a fallback when push frames are delayed or the socket is down. */
  function startPolling(runId: string) {
    stopPolling();
    pollTimer = setInterval(async () => {
      const s = get();
      if (s.runId !== runId || !["thinking", "tool", "sending"].includes(s.phase)) return;
      try {
        const run = await api.run(runId);
        if (get().runId !== runId) return;
        if (run.status === "waiting_for_approval" && run.approvalId && get().phase !== "sending") {
          get().showApproval(await api.approval(run.approvalId));
        } else if (run.status === "completed") finish(run.finalMessage);
        else if (run.status === "failed") get().fail(run.error ?? { message: "That didn't work." });
        else if (run.status === "cancelled") get().reset();
      } catch {
        /* transient; keep polling */
      }
    }, POLL_MS);
  }

  function finish(message: string | null) {
    stopPolling();
    const hadAction = get().approval !== null;
    set({ phase: "success", message: message ?? "Done.", label: "", approval: null, stream: "" });
    // Completed actions get out of the way; answers stay until dismissed.
    if (hadAction) {
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        if (get().phase === "success") {
          get().reset();
          void bridge().request("window.hide").catch(() => undefined);
        }
      }, 2200);
    }
  }

  return {
    phase: "idle",
    text: "",
    label: "",
    runId: null,
    conversationId: null,
    conversationAt: 0,
    approval: null,
    draft: {},
    message: null,
    error: null,
    stream: "",
    lastRequest: null,

    setText: (text) => set({ text }),

    async submit(inputMode = "text", provider) {
      const text = get().text.trim();
      if (!text || ["thinking", "tool", "sending"].includes(get().phase)) return;
      clearTimeout(dismissTimer);
      const fresh = Date.now() - get().conversationAt > CONVERSATION_TTL_MS;
      set({ phase: "thinking", label: "Thinking", message: null, error: null, approval: null, draft: {}, stream: "", lastRequest: text });
      try {
        const res = await api.startRun(text, fresh ? undefined : (get().conversationId ?? undefined), inputMode, provider);
        set({ runId: res.runId, conversationId: res.conversationId, conversationAt: Date.now(), text: "" });
        startPolling(res.runId);
      } catch (err) {
        get().fail(err);
      }
    },

    async retryWith(provider) {
      const text = get().lastRequest;
      if (!text) return;
      set({ text, phase: "idle" });
      await get().submit("text", provider);
    },

    setDraft: (key, value) => set({ draft: { ...get().draft, [key]: value } }),

    showApproval(approval) {
      if (approval.status !== "pending") return;
      // The push and the polling fallback can both deliver the same approval; never clobber edits.
      if (get().approval?.id === approval.id && (get().phase === "approval" || get().phase === "sending")) return;
      const draft: Record<string, string> = {};
      for (const f of approval.fields) if (f.editable) draft[f.key] = f.value;
      set({ phase: "approval", approval, draft, label: "", error: null, stream: "", runId: approval.runId ?? get().runId });
    },

    async approve() {
      const { approval, draft } = get();
      if (!approval || get().phase !== "approval") return;
      const edits: Record<string, string> = {};
      for (const f of approval.fields) if (f.editable && draft[f.key] !== undefined && draft[f.key] !== f.value) edits[f.key] = draft[f.key]!;
      if (approval.fields.some((f) => f.editable && f.kind === "longtext" && !(draft[f.key] ?? "").trim())) {
        set({ error: { message: "The message is empty." } });
        return;
      }
      set({ phase: "sending", label: "Sending", error: null });
      try {
        await api.resolveApproval(approval.id, "approve", approval.actionHash, edits);
        if (get().runId) startPolling(get().runId!);
      } catch (err) {
        // Return to the editable draft so nothing the user typed is lost.
        set({ phase: "approval", error: friendlyError(err) });
      }
    },

    async reject() {
      const { approval } = get();
      if (!approval) return get().reset();
      try {
        await api.resolveApproval(approval.id, "reject", approval.actionHash);
      } catch {
        /* already resolved elsewhere */
      }
      stopPolling();
      get().reset();
      void bridge().request("window.hide").catch(() => undefined);
    },

    onServerMessage(frame) {
      const s = get();
      switch (frame.type) {
        case "agent.progress": {
          if (frame.payload.runId !== s.runId) return;
          if (s.phase === "thinking" || s.phase === "tool") {
            const label = frame.payload.label ?? (frame.payload.status === "reasoning" ? "Thinking" : s.label);
            set({ phase: label === "Thinking" || label === "Working" ? "thinking" : "tool", label });
          } else if (s.phase === "sending" && frame.payload.label) set({ label: frame.payload.label });
          return;
        }
        case "agent.delta": {
          if (frame.payload.runId === s.runId && (s.phase === "thinking" || s.phase === "tool")) set({ stream: s.stream + frame.payload.text });
          return;
        }
        case "approval.requested": {
          const a = frame.payload.approval;
          const ours = a.runId && a.runId === s.runId;
          // Approvals from other devices/runs surface only when the palette is free.
          if (ours || s.phase === "idle" || s.phase === "success") get().showApproval(a);
          return;
        }
        case "approval.resolved": {
          if (!s.approval || frame.payload.approvalId !== s.approval.id) return;
          if (frame.payload.status === "failed") {
            void api.approval(s.approval.id).then((a) => get().fail(a.error ?? { message: "Sending failed." }));
          } else if (frame.payload.status === "executed" && !s.runId) finish("Done.");
          else if ((frame.payload.status === "rejected" || frame.payload.status === "expired") && s.phase === "approval") {
            stopPolling();
            set({ phase: "idle", approval: null, message: null });
          }
          return;
        }
        case "agent.completed": {
          if (frame.payload.runId !== s.runId) return;
          if (frame.payload.status === "completed") finish(frame.payload.message);
          else if (frame.payload.status === "failed") get().fail(frame.payload.error ?? { message: "That didn't work." });
          else if (frame.payload.status === "cancelled" && s.phase !== "approval") get().reset();
          return;
        }
        default:
          return;
      }
    },

    setListening: (listening) => set({ phase: listening ? "listening" : "transcribing", error: null, message: null }),

    async transcribed(text) {
      set({ text, phase: "idle" });
      // Voice is just another input method: same runtime, same approvals.
      if (text.trim()) await get().submit("voice");
    },

    fail(err) {
      stopPolling();
      set({ phase: "failure", error: friendlyError(err), label: "", approval: null, stream: "" });
    },

    reset() {
      stopPolling();
      clearTimeout(dismissTimer);
      set({ phase: "idle", text: "", label: "", runId: null, approval: null, draft: {}, message: null, error: null, stream: "" });
    },
  };
});
