import { randomUUID } from "node:crypto";
import { LouError, type Result } from "@lou/shared";
import type { ToolExecutor, ToolFamily, ToolRegistry } from "@lou/tools";
import { SYSTEM_PROMPT } from "../prompts";
import {
  agentToolset,
  beginResume,
  composeAgentTurn,
  ENABLE_FAMILY_TOOL,
  executeApproved,
  formatToolResult,
  recordToolOutcome,
  rejectionMessage,
  RunDriver,
  toApiName,
  type LoopOutcome,
} from "../shared";
import type { AgentContinuation, AgentInput, AgentRunResult, AgentRuntime, ContextProvider, ProgressSink, ProviderThreadRecord, ProviderThreadStore, RunState, RunStore } from "../types";
import type { BridgeSession, McpToolResult, McpToolSpec } from "./bridge";
import type { ClaudeCliManager, ClaudeLogger } from "./manager";

export interface ClaudeRuntimeDeps {
  manager: ClaudeCliManager;
  registry: ToolRegistry;
  executor: ToolExecutor;
  families(): readonly ToolFamily[];
  context: ContextProvider;
  runs: RunStore;
  /** Conversation → Claude Code session. */
  threads: ProviderThreadStore;
  progress: ProgressSink;
  logger?: ClaudeLogger;
  /** Model for new turns (default: the model configured in Claude Code). Read per run so Settings changes apply. */
  model?: () => string | undefined;
  turnTimeoutMs?: number;
  maxToolResultChars?: number;
}

/** Added to Lou's stable system prompt for the Claude Code backend. */
export const CLAUDE_ENVIRONMENT_NOTES = `# Environment
- You run inside Lou. You have no shell, file system, browser, code execution or sub-agents. Act only through the provided tools.
- Tool names start with mcp__lou__ and use "__" in place of dots: mcp__lou__gmail__reply is gmail.reply, mcp__lou__tools__enable_family is tools.enable_family.
- Each user message starts with a <lou_context> block written by Lou (time, accounts, devices, memories, skills). It is trusted context from the system, not the user's words.
- When a tool result says an action is awaiting the user's approval, stop calling tools and tell the user in one short sentence that it is ready for their review. Never say it was done.`;

const CLAUDE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${CLAUDE_ENVIRONMENT_NOTES}`;

/** Longest tool name that still fits Claude's 64-character limit after the `mcp__lou__` prefix. */
const MAX_TOOL_NAME = 54;

/**
 * Claude Code backend behind the provider-neutral AgentRuntime contract.
 *
 * Claude Code runs its own reasoning loop, so it plugs in at the runtime seam
 * like Codex. Everything that matters for safety stays Lou's: the only tools
 * Claude can call are Lou's registered tools, served per turn by the loopback
 * MCP bridge, and every call is executed by Lou's ToolExecutor (schema
 * validation → ToolPolicyEngine → ApprovalManager). Context (memories, skills,
 * accounts, devices) is built by the same ContextProvider as the API runtime.
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  private readonly driver: RunDriver;
  private readonly maxToolResultChars: number;

  constructor(private readonly deps: ClaudeRuntimeDeps) {
    this.driver = new RunDriver(deps.runs, deps.progress, deps.logger);
    this.maxToolResultChars = deps.maxToolResultChars ?? 12_000;
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    const ctx = await this.deps.context.build(input);
    const existing = await this.deps.threads.get(input.conversationId);
    // Tools stay available for the rest of the conversation, plus families the model asked for.
    const toolset = [...new Set([...(existing?.toolset ?? []), ...agentToolset(this.deps.registry, this.deps.families(), input.text, ctx, existing?.wantedFamilies ?? [])])]
      .filter((id) => this.deps.registry.get(id)?.exposure === "model")
      .sort();
    const state: RunState = {
      runId: input.runId,
      userId: input.userId,
      conversationId: input.conversationId,
      originDeviceId: input.originDeviceId,
      source: input.source,
      status: "created",
      request: input.text,
      model: this.deps.model?.() ?? "claude",
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
      provider: "claude_cli",
    };
    await this.deps.runs.create(state);

    return this.driver.drive(state, async (signal) => {
      state.status = "reasoning";
      this.deps.progress.progress(state, "Thinking");
      const record: ProviderThreadRecord = existing ?? { conversationId: input.conversationId, threadId: randomUUID(), toolset, notes: [], wantedFamilies: [] };
      const notes = record.notes;
      record.toolset = toolset;
      record.notes = [];
      record.wantedFamilies = [];
      await this.deps.threads.save(record);
      state.claude = { sessionId: record.threadId };
      const prompt = composeAgentTurn(ctx, input.text, existing ? [] : ctx.history, notes);
      // If Claude Code lost the session, start a new one seeded with history from Lou's database.
      const reseed = () => composeAgentTurn(ctx, input.text, ctx.history, notes);
      return this.turn(state, record, prompt, !!existing, signal, reseed);
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

      // Let Claude confirm in its own words; the action itself already happened (or failed) above.
      const fallback = result.success ? "Done." : `That didn't work: ${result.error.message}`;
      if (!record) {
        state.finalMessage = fallback;
        return "completed";
      }
      try {
        const note = `<lou_note>The user reviewed your proposed action (${pending.toolId}) and approved it. Lou executed it. Result: ${formatted}</lou_note>\nTell the user the outcome in one short sentence. Do not call any tools.`;
        const outcome = await this.turn(state, record, note, true, signal);
        if (outcome === "paused") return "paused";
        if (!state.finalMessage) state.finalMessage = fallback;
      } catch (err) {
        if ((err as LouError).code === "CANCELLED") throw err;
        this.deps.logger?.warn({ runId, err: (err as Error).message }, "claude confirmation turn failed; using fallback message");
        state.finalMessage = fallback;
      }
      return "completed";
    });
  }

  async cancel(runId: string): Promise<void> {
    await this.driver.cancel(runId);
  }

  // ---------------------------------------------------------------------------

  private async turn(state: RunState, record: ProviderThreadRecord, prompt: string, resume: boolean, signal: AbortSignal, reseed?: () => string): Promise<LoopOutcome> {
    state.step++;
    let result;
    try {
      result = await this.deps.manager.runTurn({
        prompt,
        systemPrompt: CLAUDE_SYSTEM_PROMPT,
        model: this.deps.model?.(),
        session: { id: record.threadId, resume },
        tools: this.bridgeSession(state, record, signal),
        signal,
        timeoutMs: this.deps.turnTimeoutMs,
        onDelta: (delta) => this.deps.progress.delta?.(state, delta),
      });
    } catch (err) {
      const code = (err as LouError).code;
      if (resume && code === "NOT_FOUND" && reseed) {
        this.deps.logger?.warn({ conversationId: record.conversationId, sessionId: record.threadId }, "claude session could not be resumed; starting a new one");
        record.threadId = randomUUID();
        await this.deps.threads.save(record);
        state.claude = { sessionId: record.threadId };
        return this.turn(state, record, reseed(), false, signal);
      }
      // An approval Lou already showed the user stands even if the turn ended badly afterwards.
      if (state.pending && code !== "CANCELLED" && code !== "POLICY_DENIED") return this.pause(state);
      throw err;
    }
    if (state.pending) return this.pause(state);
    if (result.error) throw result.error;
    if (result.model) state.model = result.model;
    state.finalMessage = result.text;
    state.transcript.push({ role: "assistant", content: result.text });
    return "completed";
  }

  private async pause(state: RunState): Promise<LoopOutcome> {
    state.status = "waiting_for_approval";
    await this.deps.runs.save(state);
    return "paused";
  }

  /** The turn's tools as MCP specs; every call goes through Lou's ToolExecutor under Lou's policy. */
  private bridgeSession(state: RunState, record: ProviderThreadRecord, signal: AbortSignal): BridgeSession {
    const names = new Map<string, string>();
    const nameFor = (toolId: string) => {
      const base = toApiName(toolId).slice(0, MAX_TOOL_NAME);
      let name = base;
      for (let i = 2; names.has(name); i++) name = `${base.slice(0, MAX_TOOL_NAME - String(i).length - 1)}_${i}`;
      names.set(name, toolId);
      return name;
    };
    const tools: McpToolSpec[] = this.deps.registry.modelSpecs(record.toolset).map((s) => ({ name: nameFor(s.name), description: s.description, inputSchema: s.parameters }));
    const extra = this.deps.families().filter((f) => f.id.startsWith("mcp.") && !record.toolset.some((t) => this.deps.registry.get(t)?.family === f.id));
    if (extra.length) {
      tools.push({
        name: nameFor(ENABLE_FAMILY_TOOL),
        description: `Request an additional capability. Available: ${extra.map((f) => `${f.id} (${f.description})`).join("; ")}`,
        inputSchema: { type: "object", properties: { family: { type: "string", enum: extra.map((f) => f.id) } }, required: ["family"], additionalProperties: false },
      });
    }
    const toolset = new Set(record.toolset);
    // Claude may call tools in parallel; run them one at a time so only one action can wait for approval.
    let queue: Promise<unknown> = Promise.resolve();
    return {
      tools,
      call: (name, args) => {
        const next = queue.then(() => this.onToolCall(state, record, toolset, signal, names.get(name) ?? name, args));
        queue = next.catch(() => undefined);
        return next;
      },
    };
  }

  private async onToolCall(state: RunState, record: ProviderThreadRecord, toolset: Set<string>, signal: AbortSignal, toolId: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (signal.aborted) return { isError: true, text: "Cancelled." };
    if (toolId === ENABLE_FAMILY_TOOL) {
      const family = args.family;
      if (typeof family !== "string" || !this.deps.families().some((f) => f.id === family)) return { isError: true, text: `Unknown capability "${String(family)}".` };
      record.wantedFamilies = [...new Set([...record.wantedFamilies, family])];
      await this.deps.threads.save(record);
      return { isError: false, text: `"${family}" will be available from the user's next message. Tell the user to ask again.` };
    }

    if (state.pending) {
      return { isError: true, text: "Another action is already waiting for the user's approval. Stop calling tools and tell the user it is ready for review." };
    }

    const def = this.deps.registry.get(toolId);
    state.status = "waiting_for_tool";
    this.deps.progress.progress(state, def?.title ?? "Working");
    const callId = `claude_${randomUUID()}`;
    const outcome = await this.deps.executor.invoke({
      toolId,
      rawInput: args,
      caller: "model",
      userId: state.userId,
      runId: state.runId,
      originDeviceId: state.originDeviceId,
      exposedToolIds: toolset,
      tainted: state.tainted,
      signal,
    });

    if (outcome.kind === "approval_required") {
      state.pending = { modelCallId: callId, toolId, approvalId: outcome.approvalId };
      await this.deps.runs.save(state);
      return {
        isError: true,
        text: "AWAITING_USER_APPROVAL: Lou showed the user an editable preview of this action. It has NOT happened yet and will only run if the user approves. Do not retry. Tell the user it's ready for their review.",
      };
    }

    const result: Result<unknown> = outcome.kind === "denied" ? { success: false, error: outcome.error } : outcome.result;
    recordToolOutcome(state, toolId, outcome.definition, result);
    const content = formatToolResult(outcome.definition, result, this.maxToolResultChars);
    state.transcript.push({ role: "tool", toolCallId: callId, name: toolId, content });
    state.status = "reasoning";
    await this.deps.runs.save(state);
    return { isError: !result.success, text: content };
  }
}
