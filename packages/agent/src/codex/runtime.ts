import { LouError, type Result } from "@lou/shared";
import { type ToolExecutor, type ToolFamily, type ToolRegistry } from "@lou/tools";
import { formatContext, SYSTEM_PROMPT } from "../prompts";
import {
  beginResume,
  ENABLE_FAMILY_TOOL,
  executeApproved,
  familyTools,
  formatToolResult,
  fromApiName,
  recordToolOutcome,
  rejectionMessage,
  requestFamilies,
  RunDriver,
  toApiName,
  type LoopOutcome,
} from "../shared";
import type { AgentContinuation, AgentInput, AgentRunResult, AgentRuntime, ContextProvider, ProgressSink, ProviderThreadRecord, ProviderThreadStore, RunContext, RunState, RunStore } from "../types";
import type { CodexAppServerManager, CodexLogger } from "./appServer";
import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec, JsonValue } from "./protocol";
import { runCodexTurn } from "./turn";

/** Persisted mapping conversation → Codex thread. The app database stays authoritative. */
export type CodexThreadRecord = ProviderThreadRecord;
export type CodexThreadStore = ProviderThreadStore;

export interface CodexRuntimeDeps {
  manager: CodexAppServerManager;
  registry: ToolRegistry;
  executor: ToolExecutor;
  families(): readonly ToolFamily[];
  context: ContextProvider;
  runs: RunStore;
  threads: CodexThreadStore;
  progress: ProgressSink;
  logger?: CodexLogger;
  /** Codex model override (default: the CLI's configured model). */
  model?: string;
  turnTimeoutMs?: number;
  maxToolResultChars?: number;
}

/** Added to Lou's stable system prompt for the Codex backend. */
export const CODEX_ENVIRONMENT_NOTES = `# Environment
- You run inside Lou. You have no shell, file system, browser, code execution or sub-agents. Act only through the provided functions.
- Function names use "__" in place of dots: gmail__reply is gmail.reply, tools__enable_family is tools.enable_family.
- Each user message starts with a <lou_context> block written by Lou (time, accounts, devices, memories, skills). It is trusted context from the system, not the user's words.
- When a function result says an action is awaiting the user's approval, stop calling functions and tell the user in one short sentence that it is ready for their review. Never say it was done.`;

interface ActiveTurn {
  state: RunState;
  toolset: Set<string>;
  signal: AbortSignal;
  record: CodexThreadRecord;
}

/**
 * Codex App Server backend behind the provider-neutral AgentRuntime contract.
 *
 * Codex runs its own reasoning loop, so it plugs in at the runtime seam (the one
 * reserved for alternative runtimes such as Hermes). Everything that matters for
 * safety stays Lou's: tools are Lou's registered tools exposed as Codex dynamic
 * tools, and every call Codex makes is executed by Lou's ToolExecutor (schema
 * validation → ToolPolicyEngine → ApprovalManager). Context (memories, skills,
 * accounts, devices) is built by the same ContextProvider as the API runtime.
 */
export class CodexAgentRuntime implements AgentRuntime {
  private readonly driver: RunDriver;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly maxToolResultChars: number;

  constructor(private readonly deps: CodexRuntimeDeps) {
    this.driver = new RunDriver(deps.runs, deps.progress, deps.logger);
    this.maxToolResultChars = deps.maxToolResultChars ?? 12_000;
    deps.manager.setToolCallHandler((params) => this.onToolCall(params));
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    const ctx = await this.deps.context.build(input);
    const record = await this.deps.threads.get(input.conversationId);
    const toolset = this.toolsetFor(input.text, ctx, record?.wantedFamilies ?? []);
    const state: RunState = {
      runId: input.runId,
      userId: input.userId,
      conversationId: input.conversationId,
      originDeviceId: input.originDeviceId,
      source: input.source,
      status: "created",
      request: input.text,
      model: this.deps.model ?? "codex",
      transcript: [{ role: "user", content: input.text }],
      exposedTools: toolset,
      loadedSkills: [],
      tainted: false,
      step: 0,
      consecutiveFailures: 0,
      pending: null,
      queue: [],
      finalMessage: null,
      error: null,
      actionsTaken: 0,
      provider: "codex_cli",
    };
    await this.deps.runs.create(state);

    return this.driver.drive(state, async (signal) => {
      state.status = "reasoning";
      this.deps.progress.progress(state, "Thinking");
      const thread = await this.threadFor(input.conversationId, toolset, record);
      state.codex = { threadId: thread.record.threadId, turnId: null };
      state.exposedTools = thread.record.toolset;
      const text = this.composeTurn(ctx, input.text, thread.fresh ? ctx.history : [], thread.record.notes);
      if (thread.record.notes.length) {
        thread.record.notes = [];
        await this.deps.threads.save(thread.record);
      }
      return this.turn(state, thread.record, text, signal);
    });
  }

  async resume(runId: string, continuation: AgentContinuation): Promise<AgentRunResult> {
    await this.driver.idle(runId);
    const { state, pending } = await beginResume(this.deps.runs, this.deps.progress, runId, continuation.approvalId);
    const title = this.deps.registry.get(pending.toolId)?.title ?? "the action";
    return this.driver.drive(state, async (signal) => {
      const record = await this.deps.threads.get(state.conversationId);
      if (continuation.decision !== "approved") {
        state.finalMessage = rejectionMessage(continuation.decision);
        if (record) {
          record.notes.push(`The action you proposed (${pending.toolId}) was ${continuation.decision === "expired" ? "not approved in time" : "cancelled by the user"}. It did not happen.`);
          await this.deps.threads.save(record);
        }
        return "completed";
      }

      this.deps.progress.progress(state, title);
      const { definition, result } = await executeApproved(this.deps.executor, state, pending, continuation, signal);
      const formatted = formatToolResult(definition, result, this.maxToolResultChars);
      state.transcript.push({ role: "tool", toolCallId: pending.modelCallId, name: pending.toolId, content: formatted });
      await this.deps.runs.save(state);

      // Let Codex confirm in its own words; the action itself already happened (or failed) above.
      const fallback = result.success ? "Done." : `That didn't work: ${result.error.message}`;
      if (!record || !state.codex) {
        state.finalMessage = fallback;
        return "completed";
      }
      try {
        await this.deps.manager.ensureThreadLoaded(record.threadId, this.threadParams());
        const note = `<lou_note>The user reviewed your proposed action (${pending.toolId}) and approved it. Lou executed it. Result: ${formatted}</lou_note>\nTell the user the outcome in one short sentence. Do not call any functions.`;
        const outcome = await this.turn(state, record, note, signal);
        if (outcome === "paused") return "paused";
        if (!state.finalMessage) state.finalMessage = fallback;
      } catch (err) {
        if ((err as LouError).code === "CANCELLED") throw err;
        this.deps.logger?.warn({ runId, err: (err as Error).message }, "codex confirmation turn failed; using fallback message");
        state.finalMessage = fallback;
      }
      return "completed";
    });
  }

  async cancel(runId: string): Promise<void> {
    await this.driver.cancel(runId);
  }

  // ---------------------------------------------------------------------------

  /** Every built-in model tool plus the most relevant tools of matching external (MCP) families. */
  private toolsetFor(text: string, ctx: RunContext, wantedFamilies: string[]): string[] {
    const families = this.deps.families();
    const selected = new Set([...requestFamilies(text, ctx.history, families), ...ctx.families, ...wantedFamilies]);
    const ids = new Set<string>();
    for (const family of families) {
      const external = family.id.startsWith("mcp.");
      if (external && !selected.has(family.id)) continue;
      for (const id of familyTools(this.deps.registry, families, family.id, text)) ids.add(id);
    }
    return [...ids].sort();
  }

  private threadParams() {
    return {
      ...(this.deps.model ? { model: this.deps.model } : {}),
      baseInstructions: SYSTEM_PROMPT,
      developerInstructions: CODEX_ENVIRONMENT_NOTES,
    };
  }

  /**
   * Reuses the conversation's thread when it already has the needed tools;
   * otherwise (first turn, new tool family, or a thread Codex lost) starts a new
   * thread seeded with history from Lou's own database.
   */
  private async threadFor(conversationId: string, toolset: string[], existing: CodexThreadRecord | undefined): Promise<{ record: CodexThreadRecord; fresh: boolean }> {
    if (existing && toolset.every((t) => existing.toolset.includes(t))) {
      try {
        await this.deps.manager.ensureThreadLoaded(existing.threadId, this.threadParams());
        return { record: existing, fresh: false };
      } catch (err) {
        if ((err as LouError).code === "NOT_CONFIGURED") throw err;
        this.deps.logger?.warn({ threadId: existing.threadId, err: (err as Error).message }, "codex thread could not be resumed; starting a new one");
      }
    }
    const union = [...new Set([...(existing?.toolset ?? []), ...toolset])].filter((id) => this.deps.registry.get(id)?.exposure === "model").sort();
    const res = await this.deps.manager.startThread({ ...this.threadParams(), dynamicTools: this.dynamicTools(union) });
    const record: CodexThreadRecord = { conversationId, threadId: res.thread.id, toolset: union, notes: existing?.notes ?? [], wantedFamilies: [] };
    await this.deps.threads.save(record);
    this.deps.logger?.info({ conversationId, threadId: record.threadId, tools: union.length }, "codex thread started");
    return { record, fresh: true };
  }

  private dynamicTools(toolIds: string[]): DynamicToolSpec[] {
    const specs: DynamicToolSpec[] = this.deps.registry.modelSpecs(toolIds).map((s) => ({
      type: "function",
      name: toApiName(s.name),
      description: s.description,
      inputSchema: s.parameters as JsonValue,
    }));
    const extra = this.deps.families().filter((f) => f.id.startsWith("mcp.") && !toolIds.some((t) => this.deps.registry.get(t)?.family === f.id));
    if (extra.length) {
      specs.push({
        type: "function",
        name: toApiName(ENABLE_FAMILY_TOOL),
        description: `Request an additional capability. Available: ${extra.map((f) => `${f.id} (${f.description})`).join("; ")}`,
        inputSchema: { type: "object", properties: { family: { type: "string", enum: extra.map((f) => f.id) } }, required: ["family"], additionalProperties: false },
      });
    }
    return specs;
  }

  private composeTurn(ctx: RunContext, request: string, history: RunContext["history"], notes: string[]): string {
    const parts = [`<lou_context>\n${formatContext(ctx)}\n</lou_context>`];
    if (history.length) {
      parts.push(`<earlier_conversation>\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}\n</earlier_conversation>`);
    }
    for (const note of notes) parts.push(`<lou_note>${note}</lou_note>`);
    parts.push(request);
    return parts.join("\n\n");
  }

  private async turn(state: RunState, record: CodexThreadRecord, text: string, signal: AbortSignal): Promise<LoopOutcome> {
    const active: ActiveTurn = { state, toolset: new Set(record.toolset), signal, record };
    this.activeTurns.set(record.threadId, active);
    state.step++;
    try {
      const result = await runCodexTurn(this.deps.manager, {
        threadId: record.threadId,
        text,
        model: this.deps.model,
        signal,
        timeoutMs: this.deps.turnTimeoutMs,
        observer: {
          onTurnStarted: (turnId) => {
            if (state.codex) state.codex.turnId = turnId;
          },
          onDelta: (delta) => this.deps.progress.delta?.(state, delta),
        },
      });

      if (result.status === "failed") {
        if (state.pending) return this.pause(state);
        throw new LouError("MODEL_ERROR", result.error?.message ? `Codex: ${result.error.message}` : "Codex couldn't complete this request.");
      }
      if (result.status === "interrupted") {
        if (state.pending) return this.pause(state);
        throw new LouError("CANCELLED", "Cancelled.");
      }
      if (state.pending) return this.pause(state);
      state.finalMessage = result.text;
      state.transcript.push({ role: "assistant", content: result.text });
      return "completed";
    } finally {
      this.activeTurns.delete(record.threadId);
      if (state.codex) state.codex.turnId = null;
    }
  }

  private async pause(state: RunState): Promise<LoopOutcome> {
    state.status = "waiting_for_approval";
    await this.deps.runs.save(state);
    return "paused";
  }

  /** Every Codex dynamic tool call is executed by Lou's ToolExecutor under Lou's policy. */
  private async onToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const active = this.activeTurns.get(params.threadId);
    if (!active) return reply(false, "No active Lou request for this conversation.");
    const { state } = active;
    const toolId = fromApiName(params.tool);

    if (toolId === ENABLE_FAMILY_TOOL) {
      const family = (params.arguments as { family?: string } | null)?.family;
      if (!family || !this.deps.families().some((f) => f.id === family)) return reply(false, `Unknown capability "${String(family)}".`);
      active.record.wantedFamilies = [...new Set([...active.record.wantedFamilies, family])];
      await this.deps.threads.save(active.record);
      return reply(true, `"${family}" will be available from the user's next message. Tell the user to ask again.`);
    }

    if (state.pending) {
      return reply(false, "Another action is already waiting for the user's approval. Stop calling functions and tell the user it is ready for review.");
    }

    const def = this.deps.registry.get(toolId);
    state.status = "waiting_for_tool";
    this.deps.progress.progress(state, def?.title ?? "Working");
    const outcome = await this.deps.executor.invoke({
      toolId,
      rawInput: params.arguments,
      caller: "model",
      userId: state.userId,
      runId: state.runId,
      originDeviceId: state.originDeviceId,
      exposedToolIds: active.toolset,
      tainted: state.tainted,
      signal: active.signal,
    });

    if (outcome.kind === "approval_required") {
      state.pending = { modelCallId: params.callId, toolId, approvalId: outcome.approvalId };
      await this.deps.runs.save(state);
      return reply(false, "AWAITING_USER_APPROVAL: Lou showed the user an editable preview of this action. It has NOT happened yet and will only run if the user approves. Do not retry. Tell the user it's ready for their review.");
    }

    const result: Result<unknown> = outcome.kind === "denied" ? { success: false, error: outcome.error } : outcome.result;
    recordToolOutcome(state, toolId, outcome.definition, result);
    const content = formatToolResult(outcome.definition, result, this.maxToolResultChars);
    state.transcript.push({ role: "tool", toolCallId: params.callId, name: toolId, content });
    state.status = "reasoning";
    await this.deps.runs.save(state);
    return reply(result.success, content);
  }
}

function reply(success: boolean, text: string): DynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text }] };
}
