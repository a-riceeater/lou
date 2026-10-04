import { Bm25Index, LouError, toLouError, wrapUntrusted, type Result, type SerializedError } from "@lou/shared";
import type { AnyToolDefinition, ToolExecutor, ToolFamily, ToolRegistry } from "@lou/tools";
import type { AgentContinuation, AgentRunResult, PendingToolCall, ProgressSink, RunState, RunStore } from "./types";

/**
 * Logic shared by every runtime implementation (custom Luna loop, Codex App
 * Server, …) so tool exposure, result formatting and run bookkeeping behave
 * identically regardless of which model backend drives the run.
 */

export const ENABLE_FAMILY_TOOL = "tools.enable_family";
export const SKILL_READ_TOOL = "skills.read";

/** Model-exposed tools of a family; large families are narrowed to the most relevant tools for `text`. */
export function familyTools(registry: ToolRegistry, families: readonly ToolFamily[], familyId: string, text: string): string[] {
  const defs = registry.byFamily(familyId).filter((d) => d.exposure === "model");
  const max = families.find((f) => f.id === familyId)?.maxTools;
  if (!max || defs.length <= max) return defs.map((d) => d.id);
  const index = new Bm25Index(defs.map((d) => ({ id: d.id, text: `${d.id.replace(/[._]/g, " ")} ${d.description}` })));
  const ranked = index.search(text, max).map((h) => h.id);
  return ranked.length ? ranked : defs.slice(0, max).map((d) => d.id);
}

/** Serializes a tool result for the model. External content is wrapped in the untrusted envelope. */
export function formatToolResult(def: AnyToolDefinition | undefined, result: Result<unknown>, maxChars: number): string {
  const body = result.success
    ? { success: true, data: result.data }
    : { success: false, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } satisfies Omit<SerializedError, "details"> };
  let json = JSON.stringify(body);
  if (json.length > maxChars) json = `${json.slice(0, maxChars)}…[truncated]`;
  return def?.untrustedOutput && result.success ? wrapUntrusted(def.id, json) : json;
}

/**
 * Updates run bookkeeping after a tool result: taint, failure streaks, side
 * effects and loaded skills. Returns tool IDs a loaded skill asks to offer.
 */
export function recordToolOutcome(state: RunState, toolId: string, def: AnyToolDefinition | undefined, result: Result<unknown>): string[] {
  if (!result.success) {
    state.consecutiveFailures++;
    return [];
  }
  state.consecutiveFailures = 0;
  if (def && def.risk !== "read") state.actionsTaken++;
  if (def?.untrustedOutput) state.tainted = true;
  if (toolId !== SKILL_READ_TOOL) return [];
  const skill = result.data as { id?: unknown; tools?: unknown };
  if (typeof skill?.id === "string" && !state.loadedSkills.includes(skill.id)) state.loadedSkills.push(skill.id);
  return Array.isArray(skill?.tools) ? skill.tools.filter((t): t is string => typeof t === "string") : [];
}

/** Provider-safe tool names: the APIs forbid dots (`gmail.search` → `gmail__search`). */
export function toApiName(name: string): string {
  return name.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function fromApiName(name: string): string {
  return name.replace(/__/g, ".");
}

/** Run outcome of a runtime body: finished, or paused waiting for an approval. */
export type LoopOutcome = "completed" | "paused";

export interface DriverLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Run lifecycle shared by runtimes: one execution per run at a time, abortable,
 * final status/persistence/progress handled identically for every backend.
 */
export class RunDriver {
  private readonly active = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly runs: RunStore,
    private readonly progress: ProgressSink,
    private readonly logger?: DriverLogger,
  ) {}

  /**
   * Waits until the run is not executing. An approval can be resolved while the
   * backend is still finishing the turn that requested it (e.g. Codex writing
   * "ready for review"); resumption must wait for that turn to settle.
   */
  async idle(runId: string): Promise<void> {
    await this.running.get(runId)?.catch(() => undefined);
  }

  drive(state: RunState, body: (signal: AbortSignal) => Promise<LoopOutcome>): Promise<AgentRunResult> {
    const promise = this.execute(state, body);
    this.running.set(state.runId, promise);
    void promise.finally(() => {
      if (this.running.get(state.runId) === promise) this.running.delete(state.runId);
    });
    return promise;
  }

  private async execute(state: RunState, body: (signal: AbortSignal) => Promise<LoopOutcome>): Promise<AgentRunResult> {
    if (this.active.has(state.runId)) throw new LouError("CONFLICT", "This run is already executing.");
    const controller = new AbortController();
    this.active.set(state.runId, controller);
    try {
      const outcome = await body(controller.signal);
      if (outcome === "completed") {
        state.status = "completed";
        state.finalMessage = state.finalMessage?.trim() || "Done.";
      }
    } catch (e) {
      const error = toLouError(e);
      state.status = error.code === "CANCELLED" ? "cancelled" : "failed";
      state.error = error.code === "CANCELLED" ? null : error.toJSON();
      state.finalMessage = error.code === "CANCELLED" ? "Cancelled." : null;
      state.pending = null;
      this.logger?.[error.code === "CANCELLED" ? "info" : "error"]({ runId: state.runId, code: error.code, err: error.message }, "agent run ended early");
    } finally {
      this.active.delete(state.runId);
    }
    await this.runs.save(state);
    if (state.status === "waiting_for_approval") this.progress.progress(state);
    else this.progress.completed(state);
    return { runId: state.runId, status: state.status, finalMessage: state.finalMessage, approvalId: state.pending?.approvalId ?? null, error: state.error };
  }

  async cancel(runId: string): Promise<void> {
    const controller = this.active.get(runId);
    if (controller) {
      controller.abort();
      return;
    }
    const state = await this.runs.load(runId);
    if (!state || ["completed", "failed", "cancelled"].includes(state.status)) return;
    state.status = "cancelled";
    state.pending = null;
    state.finalMessage = "Cancelled.";
    await this.runs.save(state);
    this.progress.completed(state);
  }
}

/** Validates that a run is paused on exactly this approval and marks it resuming. */
export async function beginResume(runs: RunStore, progress: ProgressSink, runId: string, approvalId: string): Promise<{ state: RunState; pending: PendingToolCall }> {
  const state = await runs.load(runId);
  if (!state) throw new LouError("NOT_FOUND", `Run ${runId} not found.`);
  if (state.status !== "waiting_for_approval" || !state.pending || state.pending.approvalId !== approvalId) {
    throw new LouError("CONFLICT", "This run is not waiting for that approval.");
  }
  const pending = state.pending;
  state.status = "resuming";
  state.pending = null;
  await runs.save(state);
  progress.progress(state);
  return { state, pending };
}

/** Executes exactly the action the user approved (hash-bound grant), for any runtime. */
export async function executeApproved(
  executor: ToolExecutor,
  state: RunState,
  pending: PendingToolCall,
  continuation: Extract<AgentContinuation, { decision: "approved" }>,
  signal: AbortSignal,
): Promise<{ definition: AnyToolDefinition | undefined; result: Result<unknown> }> {
  const outcome = await executor.invoke({
    toolId: pending.toolId,
    rawInput: continuation.input,
    caller: "model",
    userId: state.userId,
    runId: state.runId,
    originDeviceId: state.originDeviceId,
    exposedToolIds: new Set([...state.exposedTools, pending.toolId]),
    tainted: state.tainted,
    grant: { approvalId: continuation.approvalId, toolId: pending.toolId, inputHash: continuation.inputHash },
    signal,
  });
  if (outcome.kind === "approval_required") {
    // A grant that matches policy never needs approval again; treat as an integrity failure.
    throw new LouError("APPROVAL_MISMATCH", "The approved action could not be executed as approved.");
  }
  const result: Result<unknown> = outcome.kind === "denied" ? { success: false, error: outcome.error } : outcome.result;
  if (result.success) state.actionsTaken++;
  return { definition: outcome.definition, result };
}

export function rejectionMessage(decision: "rejected" | "expired"): string {
  return decision === "expired" ? "That approval expired, so nothing was done." : "Okay, I cancelled that.";
}
