import { LouError } from "@lou/shared";
import type { ModelProvider, ModelRequest, ModelResponse } from "../model";
import type { ClaudeCliManager } from "./manager";

/**
 * ModelProvider over Claude Code for single-shot structured tasks (importance
 * classification, drafting, improvement evaluation). Each call is a throwaway,
 * unsaved session with no tools; JSON output uses `--json-schema`.
 * Agent runs with tools use ClaudeAgentRuntime instead.
 */
export class ClaudeModelProvider implements ModelProvider {
  readonly id = "claude";

  constructor(
    private readonly manager: ClaudeCliManager,
    private readonly options: { model?: () => string | undefined; timeoutMs?: number } = {},
  ) {}

  get defaultModel(): string {
    return this.options.model?.() ?? "claude";
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (request.tools?.length) {
      throw new LouError("NOT_CONFIGURED", "Tool use with Claude Code runs through the Claude agent runtime, not single-shot completions.");
    }
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const conversation = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => (m.role === "user" ? m.content : m.role === "assistant" ? `Assistant: ${m.content}` : `Tool result: ${m.content}`))
      .join("\n\n");
    const model = request.model && request.model !== this.defaultModel ? request.model : this.options.model?.();

    const result = await this.manager.runTurn({
      prompt: conversation || "Respond.",
      systemPrompt: system || "Answer directly.",
      model,
      jsonSchema: request.responseFormat?.schema,
      signal,
      timeoutMs: this.options.timeoutMs ?? 120_000,
      onDelta: request.onTextDelta,
    });
    if (result.error) throw result.error;
    const text = result.structured !== undefined && result.structured !== null ? JSON.stringify(result.structured) : result.text;
    return { text, toolCalls: [], model: result.model ?? model ?? this.defaultModel };
  }
}
