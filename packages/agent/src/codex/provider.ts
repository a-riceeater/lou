import { LouError } from "@lou/shared";
import type { ModelProvider, ModelRequest, ModelResponse } from "../model";
import type { CodexAppServerManager } from "./appServer";
import type { JsonValue } from "./protocol";
import { codexExec } from "./exec";
import { runCodexTurn } from "./turn";

/**
 * ModelProvider over Codex for single-shot structured tasks (importance
 * classification, drafting, improvement evaluation). Each call is an ephemeral
 * Codex thread with no tools; JSON output uses the turn's `outputSchema`.
 * Agent runs with tools use CodexAgentRuntime instead.
 */
export class CodexModelProvider implements ModelProvider {
  readonly id = "codex";
  readonly defaultModel: string;

  constructor(
    private readonly manager: CodexAppServerManager,
    private readonly options: { model?: string; timeoutMs?: number } = {},
  ) {
    this.defaultModel = options.model ?? "codex";
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (request.tools?.length) {
      throw new LouError("NOT_CONFIGURED", "Tool use with Codex runs through the Codex agent runtime, not single-shot completions.");
    }
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const conversation = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => (m.role === "user" ? m.content : m.role === "assistant" ? `Assistant: ${m.content}` : `Tool result: ${m.content}`))
      .join("\n\n");

    const model = request.model && request.model !== this.defaultModel ? request.model : this.options.model;

    // Compatibility path for CLIs without App Server: structured `codex exec --json`.
    if (this.manager.supportsAppServer !== true) {
      try {
        await this.manager.ensureStarted();
      } catch (err) {
        const fallback = this.manager.supportsAppServer === false ? this.manager.execFallback() : undefined;
        if (!fallback) throw err;
        const prompt = [system && `<instructions>\n${system}\n</instructions>`, conversation || "Respond."].filter(Boolean).join("\n\n");
        const text = await codexExec({ ...fallback, model, timeoutMs: this.options.timeoutMs ?? 120_000 }, prompt, request.responseFormat?.schema, signal);
        return { text, toolCalls: [], model: model ?? this.defaultModel };
      }
    }

    const thread = await this.manager.startThread({
      ephemeral: true,
      ...(model ? { model } : {}),
      ...(system ? { baseInstructions: system } : {}),
      developerInstructions: "Answer directly. You have no tools.",
    });
    const result = await runCodexTurn(this.manager, {
      threadId: thread.thread.id,
      text: conversation || "Respond.",
      model,
      outputSchema: (request.responseFormat?.schema as JsonValue | undefined) ?? undefined,
      signal,
      timeoutMs: this.options.timeoutMs ?? 120_000,
    });
    if (result.status !== "completed") {
      throw new LouError("MODEL_ERROR", result.error?.message ? `Codex: ${result.error.message}` : `Codex turn ${result.status}.`);
    }
    return { text: result.text, toolCalls: [], model: thread.model ?? this.defaultModel };
  }
}
