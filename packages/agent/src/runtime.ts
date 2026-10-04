import { LouError, toLouError, type Result } from "@lou/shared";
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
import {
  beginResume,
  ENABLE_FAMILY_TOOL,
  executeApproved,
  familyTools,
  formatToolResult,
  recordToolOutcome,
  rejectionMessage,
  RunDriver,
  type LoopOutcome,
} from "./shared";
import type { AgentContinuation, AgentInput, AgentRunResult, AgentRuntime, ContextProvider, ProgressSink, RunState, RunStore } from "./types";

export { ENABLE_FAMILY_TOOL, SKILL_READ_TOOL } from "./shared";

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

/**
 * The custom Luna runtime: a bounded model ↔ tool loop with persisted state,
 * policy-gated tool execution, approval pauses and resumption from any device.
 */
export class CustomLunaRuntime implements AgentRuntime {
  private readonly driver: RunDriver;
  private readonly maxSteps: number;
  private readonly maxToolResultChars: number;

  constructor(private readonly deps: CustomRuntimeDeps) {
    this.maxSteps = deps.maxSteps ?? 10;
    this.maxToolResultChars = deps.maxToolResultChars ?? 12_000;
    this.driver = new RunDriver(deps.runs, deps.progress, deps.logger);
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    const ctx = await this.deps.context.build(input);
    const families = new Set([...selectFamilies(input.text, this.deps.families()), ...ctx.families]);
    const exposed = new Set<string>();
    for (const family of families) for (const id of this.familyTools(family, input.text)) exposed.add(id);

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
      provider: "openai_api",
    };
    await this.deps.runs.create(state);
    return this.driver.drive(state, async (signal) => this.loop(state, signal));
  }

  async resume(runId: string, continuation: AgentContinuation): Promise<AgentRunResult> {
    await this.driver.idle(runId);
    const { state, pending } = await beginResume(this.deps.runs, this.deps.progress, runId, continuation.approvalId);
    return this.driver.drive(state, async (signal) => {
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
        state.finalMessage = rejectionMessage(continuation.decision);
        return "completed";
      }

      this.deps.progress.progress(state, this.deps.registry.get(pending.toolId)?.title);
      const { definition, result } = await executeApproved(this.deps.executor, state, pending, continuation, signal);
      this.pushToolMessage(state, pending.modelCallId, pending.toolId, definition, result);
      await this.deps.runs.save(state);

      const queued = await this.processQueue(state, signal);
      if (queued === "paused") return "paused";
      return this.loop(state, signal);
    });
  }

  async cancel(runId: string): Promise<void> {
    return this.driver.cancel(runId);
  }

  // -------------------------------------------------------------------------

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
      this.offer(state, recordToolOutcome(state, call.name, outcome.definition, result));
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
    const added = this.familyTools(family, state.request).filter((id) => !state.exposedTools.includes(id));
    state.exposedTools = [...state.exposedTools, ...added].sort();
    return { success: true, data: { enabled: added } };
  }

  private familyTools(familyId: string, text: string): string[] {
    return familyTools(this.deps.registry, this.deps.families(), familyId, text);
  }

  /** Skills only change which tools are *offered*; policy still governs execution. */
  private offer(state: RunState, toolIds: string[]): void {
    for (const toolId of toolIds) {
      const def = this.deps.registry.get(toolId);
      if (def && def.exposure === "model" && !state.exposedTools.includes(def.id)) state.exposedTools.push(def.id);
    }
  }

  private pushToolMessage(state: RunState, callId: string, name: string, def: AnyToolDefinition | undefined, result: Result<unknown>): void {
    state.transcript.push({ role: "tool", toolCallId: callId, name, content: this.formatResult(def, result) });
  }

  private formatResult(def: AnyToolDefinition | undefined, result: Result<unknown>): string {
    return formatToolResult(def, result, this.maxToolResultChars);
  }
}
