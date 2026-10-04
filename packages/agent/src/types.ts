import type { RunStatus } from "@lou/protocol";
import type { SerializedError } from "@lou/shared";
import type { ModelMessage } from "./model";

/** Provider-neutral runtime contract (ARCHITECTURE.md §3.1, §11). */
export interface AgentRuntime {
  run(input: AgentInput): Promise<AgentRunResult>;
  resume(runId: string, continuation: AgentContinuation): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
}

export interface AgentInput {
  runId: string;
  userId: string;
  conversationId: string;
  text: string;
  source: "user" | "event";
  originDeviceId?: string;
}

export type AgentContinuation =
  | {
      type: "approval";
      approvalId: string;
      decision: "approved";
      /** The exact final input the user approved (after edits). */
      input: Record<string, unknown>;
      inputHash: string;
    }
  | { type: "approval"; approvalId: string; decision: "rejected" | "expired" };

export interface AgentRunResult {
  runId: string;
  status: RunStatus;
  finalMessage: string | null;
  approvalId: string | null;
  error: SerializedError | null;
}

export interface PendingToolCall {
  /** Model-issued call ID (transcript linkage). */
  modelCallId: string;
  toolId: string;
  approvalId: string;
}

/**
 * Persisted, model-visible run state. Contains only what the model saw and did —
 * requests, tool calls, tool results, selected skills, final answer. No hidden
 * reasoning is ever requested or stored.
 */
export interface RunState {
  runId: string;
  userId: string;
  conversationId: string;
  originDeviceId?: string;
  source: "user" | "event";
  status: RunStatus;
  request: string;
  model: string;
  /** Conversation transcript after the stable system prompt. */
  transcript: ModelMessage[];
  exposedTools: string[];
  loadedSkills: string[];
  tainted: boolean;
  step: number;
  consecutiveFailures: number;
  pending: PendingToolCall | null;
  /** Remaining model tool calls from the current turn, processed after the pending one. */
  queue: Array<{ id: string; name: string; arguments: string }>;
  finalMessage: string | null;
  error: SerializedError | null;
  /** Number of tool calls that produced a real side effect (for history outcome). */
  actionsTaken: number;
  /** Which model provider drives this run; resumption goes back to the same one. */
  provider?: ProviderId;
  /** Codex App Server linkage (Codex provider only). */
  codex?: { threadId: string; turnId: string | null };
}

export type ProviderId = "openai_api" | "codex_cli";

export interface RunStore {
  create(state: RunState): Promise<void>;
  save(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | undefined>;
}

export interface ProgressSink {
  progress(state: RunState, label?: string): void;
  completed(state: RunState): void;
  /** Streamed assistant text, when the provider streams. */
  delta?(state: RunState, text: string): void;
}

export interface RunContext {
  userName: string;
  timezone: string;
  now: Date;
  memories: Array<{ type: string; content: string; source: string }>;
  skills: Array<{ id: string; description: string }>;
  accounts: Array<{ id: string; provider: string; address: string | null; displayName: string; status: string }>;
  devices: Array<{ id: string; name: string; platform: string; online: boolean; current: boolean }>;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** Extra tool families suggested by context (e.g. from matched skills). */
  families: string[];
}

export interface ContextProvider {
  build(input: AgentInput): Promise<RunContext>;
}
