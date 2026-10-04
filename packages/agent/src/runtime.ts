import { LouError, toLouError, wrapUntrusted, type Result, type SerializedError } from "@lou/shared";
import {
  selectFamilies,
  type AnyToolDefinition,
  type ModelToolSpec,
  type ToolExecutor,
  type ToolFamily,
  type ToolRegistry,
} from "@lou/tools";
import type { ModelMessage, ModelRouter, ModelToolCall } from "./model";
import { formatContext, SYSTEM_PROMPT } from "./prompts";
import type { AgentContinuation, AgentInput, AgentRunResult, AgentRuntime, ContextProvider, ProgressSink, RunState, RunStore } from "./types";

export const ENABLE_FAMILY_TOOL = "tools.enable_family";
export const SKILL_READ_TOOL = "skills.read";

export interface RuntimeLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface CustomRuntimeDeps {
  router: ModelRouter;
  registry: ToolRegistry;
  executor: ToolExecutor;
  families(): readonly ToolFamily[];
  context: ContextProvider;
  runs: RunStore;
  progress: ProgressSink;
  logger?: RuntimeLogger;
  /** Maximum model calls per run. */
  maxSteps?: number;
  /** Tool results longer than this are truncated before reaching the model. */
  maxToolResultChars?: number;
}

type LoopOutcome = "completed" | "paused";

/**
 * The custom Luna runtime: a bounded model ↔ tool loop with persisted state,
 * policy-gated tool execution, approval pauses and resumption from any device.
 */
export class CustomLunaRuntime implements AgentRuntime {
  private readonly active = new Map<string, AbortController>();
  private readonly maxSteps: number;
  private readonly maxToolResultChars: number;

  constructor(private readonly deps: CustomRuntimeDeps) {
    this.maxSteps = deps.maxSteps ?? 10;
    this.maxToolResultChars = deps.maxToolResultChars ?? 12_000;
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    const ctx = await this.deps.context.build(input);
    const families = new Set([...selectFamilies(input.text, this.deps.families()), ...ctx.families]);
    const exposed = new Set<string>();
    for (const family of families) for (const def of this.deps.registry.byFamily(family)) if (def.exposure === "model") exposed.add(def.id);

    const transcript: ModelMessage[] = [
      ...ctx.history.map((h) => ({ role: h.role, content: h.content }) as ModelMessage),
      { role: "system", content: formatContext(ctx) },
      { role: "user", content: input.text },
    ];

    const state: RunState = {
      runId: input.runId,
      userId: input.userId,
      conversationId: input.conversationId,
      originDeviceId: input.originDeviceId,
      source: input.source,
      status: "created",
      request: input.text,
      model: this.deps.router.primary.defaultModel,
      transcript,
      exposedTools: [...exposed].sort(),
      loadedSkills: [],
      tainted: false,
      step: 0,
      consecutiveFailures: 0,
      pending: null,
      queue: [],
      finalMessage: null,
      error: null,
      actionsTaken: 0,
    };
    await this.deps.runs.create(state);
    return this.drive(state, async (signal) => this.loop(state, signal));
  }

  async resume(runId: string, continuation: AgentContinuation): Promise<AgentRunResult> {
    const state = await this.deps.runs.load(runId);
    if (!state) throw new LouError("NOT_FOUND", `Run ${runId} not found.`);
    if (state.status !== "waiting_for_approval" || !state.pending || state.pending.approvalId !== continuation.approvalId) {
      throw new LouError("CONFLICT", "This run is not waiting for that approval.");
    }
    const pending = state.pending;
    state.status = "resuming";
    state.pending = null;
    await this.deps.runs.save(state);
    this.deps.progress.progress(state);

    return this.drive(state, async (signal) => {
      if (continuation.decision !== "approved") {
        const reason = continuation.decision === "expired" ? "The approval expired." : "The user cancelled this action.";
        this.pushToolMessage(state, pending.modelCallId, pending.toolId, undefined, {
          success: false,
          error: { code: continuation.decision === "expired" ? "APPROVAL_EXPIRED" : "USER_REJECTED", message: reason, retryable: false },
        });
        for (const skipped of state.queue) {
          this.pushToolMessage(state, skipped.id, skipped.name, undefined, {
            success: false,
            error: { code: "CANCELLED", message: "Skipped because the user cancelled the previous action.", retryable: false },
          });
        }
        state.queue = [];
        state.finalMessage = continuation.decision === "expired" ? "That approval expired, so nothing was done." : "Okay, I cancelled that.";
        return "completed";
      }

      this.deps.progress.progress(state, this.deps.registry.get(pending.toolId)?.title);
      const outcome = await this.deps.executor.invoke({
        toolId: pending.toolId,
        rawInput: continuation.input,
        caller: "model",
        userId: state.userId,
        runId: state.runId,
        originDeviceId: state.originDeviceId,
        exposedToolIds: new Set(state.exposedTools),
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
      this.pushToolMessage(state, pending.modelCallId, pending.toolId, outcome.definition, result);
      await this.deps.runs.save(state);

      const queued = await this.processQueue(state, signal);
      if (queued === "paused") return "paused";
      return this.loop(state, signal);
    });
  }

  async cancel(runId: string): Promise<void> {
    const controller = this.active.get(runId);
    if (controller) {
      controller.abort();
      return;
    }
    const state = await this.deps.runs.load(runId);
    if (!state || ["completed", "failed", "cancelled"].includes(state.status)) return;
    state.status = "cancelled";
    state.pending = null;
    state.finalMessage = "Cancelled.";
    await this.deps.runs.save(state);
    this.deps.progress.completed(state);
  }

  // -------------------------------------------------------------------------

  private async drive(state: RunState, body: (signal: AbortSignal) => Promise<LoopOutcome>): Promise<AgentRunResult> {
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
      this.deps.logger?.[error.code === "CANCELLED" ? "info" : "error"]({ runId: state.runId, code: error.code, err: error.message }, "agent run ended early");
    } finally {
      this.active.delete(state.runId);
    }
    await this.deps.runs.save(state);
    if (state.status === "waiting_for_approval") this.deps.progress.progress(state);
    else this.deps.progress.completed(state);
    return {
      runId: state.runId,
      status: state.status,
      finalMessage: state.finalMessage,
      approvalId: state.pending?.approvalId ?? null,
      error: state.error,
    };
  }

  private async loop(state: RunState, signal: AbortSignal): Promise<LoopOutcome> {
    while (true) {
      if (signal.aborted) throw new LouError("CANCELLED", "Cancelled.");
      if (state.step >= this.maxSteps) {
        throw new LouError("INTERNAL", "I couldn't finish this in a reasonable number of steps.");
      }
      state.step++;
      state.status = "reasoning";
      this.deps.progress.progress(state, state.step === 1 ? "Thinking" : "Working");

      const { provider, model } = this.deps.router.select({ consecutiveToolFailures: state.consecutiveFailures });
      state.model = model;
      const response = await provider.complete(
        {
          purpose: "agent",
          model,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...state.transcript],
          tools: this.toolSpecs(state),
          maxOutputTokens: 2000,
          cacheKey: `lou-agent-${state.userId}`,
        },
        signal,
      );

      if (!response.toolCalls.length) {
        state.finalMessage = response.text;
        state.transcript.push({ role: "assistant", content: response.text });
        return "completed";
      }

      state.transcript.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
      state.queue = [...response.toolCalls];
      await this.deps.runs.save(state);
      if ((await this.processQueue(state, signal)) === "paused") return "paused";
    }
  }

  private async processQueue(state: RunState, signal: AbortSignal): Promise<LoopOutcome | "drained"> {
    while (state.queue.length) {
      const call = state.queue.shift() as ModelToolCall;
      if (signal.aborted) throw new LouError("CANCELLED", "Cancelled.");

      let args: unknown;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        this.pushToolMessage(state, call.id, call.name, undefined, {
          success: false,
          error: { code: "VALIDATION_FAILED", message: "Arguments were not valid JSON.", retryable: false },
        });
        continue;
      }

      if (call.name === ENABLE_FAMILY_TOOL) {
        this.pushToolMessage(state, call.id, call.name, undefined, this.enableFamily(state, args));
        continue;
      }

      const definition = this.deps.registry.get(call.name);
      state.status = "waiting_for_tool";
      this.deps.progress.progress(state, definition?.title ?? "Working");

      const outcome = await this.deps.executor.invoke({
        toolId: call.name,
        rawInput: args,
        caller: "model",
        userId: state.userId,
        runId: state.runId,
        originDeviceId: state.originDeviceId,
        exposedToolIds: new Set(state.exposedTools),
        tainted: state.tainted,
        signal,
      });

      if (outcome.kind === "approval_required") {
        state.pending = { modelCallId: call.id, toolId: call.name, approvalId: outcome.approvalId };
        state.status = "waiting_for_approval";
        await this.deps.runs.save(state);
        return "paused";
      }

      const result: Result<unknown> = outcome.kind === "denied" ? { success: false, error: outcome.error } : outcome.result;
      if (result.success) {
        state.consecutiveFailures = 0;
        if (outcome.definition && outcome.definition.risk !== "read") state.actionsTaken++;
        if (outcome.definition?.untrustedOutput) state.tainted = true;
        if (call.name === SKILL_READ_TOOL) this.onSkillLoaded(state, result.data);
      } else {
        state.consecutiveFailures++;
      }
      this.pushToolMessage(state, call.id, call.name, outcome.definition, result);
      // Persist after every external tool call (AGENT_SYSTEM.md §14).
      await this.deps.runs.save(state);
    }
    return "drained";
  }

  private toolSpecs(state: RunState): ModelToolSpec[] {
    const specs = this.deps.registry.modelSpecs(state.exposedTools);
    const available = this.deps.families().filter((f) => !f.core && !this.familyEnabled(state, f.id) && this.deps.registry.byFamily(f.id).length);
    if (available.length) {
      specs.push({
        name: ENABLE_FAMILY_TOOL,
        description: `Enable an additional tool family for this request. Available: ${available.map((f) => `${f.id} (${f.description})`).join("; ")}`,
        parameters: {
          type: "object",
          properties: { family: { type: "string", enum: available.map((f) => f.id) } },
          required: ["family"],
          additionalProperties: false,
        },
      });
    }
    return specs;
  }

  private familyEnabled(state: RunState, family: string): boolean {
    const tools = this.deps.registry.byFamily(family).filter((d) => d.exposure === "model");
    return tools.length > 0 && tools.every((d) => state.exposedTools.includes(d.id));
  }

  private enableFamily(state: RunState, args: unknown): Result<unknown> {
    const family = (args as { family?: unknown })?.family;
    const known = this.deps.families().find((f) => f.id === family);
    if (typeof family !== "string" || !known) {
      return { success: false, error: { code: "VALIDATION_FAILED", message: `Unknown tool family "${String(family)}".`, retryable: false } };
    }
    const added = this.deps.registry
      .byFamily(family)
      .filter((d) => d.exposure === "model" && !state.exposedTools.includes(d.id))
      .map((d) => d.id);
    state.exposedTools = [...state.exposedTools, ...added].sort();
    return { success: true, data: { enabled: added } };
  }

  private onSkillLoaded(state: RunState, data: unknown): void {
    const skill = data as { id?: unknown; tools?: unknown };
    if (typeof skill?.id === "string" && !state.loadedSkills.includes(skill.id)) state.loadedSkills.push(skill.id);
    if (Array.isArray(skill?.tools)) {
      for (const toolId of skill.tools) {
        const def = typeof toolId === "string" ? this.deps.registry.get(toolId) : undefined;
        // Skills only change which tools are *offered*; policy still governs execution.
        if (def && def.exposure === "model" && !state.exposedTools.includes(def.id)) state.exposedTools.push(def.id);
      }
    }
  }

  private pushToolMessage(state: RunState, callId: string, name: string, def: AnyToolDefinition | undefined, result: Result<unknown>): void {
    state.transcript.push({ role: "tool", toolCallId: callId, name, content: this.formatResult(def, result) });
  }

  private formatResult(def: AnyToolDefinition | undefined, result: Result<unknown>): string {
    const body = result.success
      ? { success: true, data: result.data }
      : { success: false, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } satisfies Omit<SerializedError, "details"> };
    let json = JSON.stringify(body);
    if (json.length > this.maxToolResultChars) json = `${json.slice(0, this.maxToolResultChars)}…[truncated]`;
    return def?.untrustedOutput && result.success ? wrapUntrusted(def.id, json) : json;
  }
}
