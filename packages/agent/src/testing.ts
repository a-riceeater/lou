import type { ModelProvider, ModelRequest, ModelResponse } from "./model";

/**
 * Deterministic provider for tests and offline development. Each step is either a
 * canned response or a function of the request (to assert on what the model saw).
 */
export type ScriptStep = Partial<ModelResponse> | ((request: ModelRequest) => Partial<ModelResponse>);

export class ScriptedModelProvider implements ModelProvider {
  readonly id = "scripted";
  readonly defaultModel = "scripted-luna";
  readonly requests: ModelRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    this.requests.push(structuredClone(request));
    const step = this.steps[this.cursor++];
    if (!step) throw new Error(`ScriptedModelProvider ran out of steps at call ${this.cursor}`);
    const partial = typeof step === "function" ? step(request) : step;
    return { text: partial.text ?? "", toolCalls: partial.toolCalls ?? [], model: partial.model ?? this.defaultModel, usage: partial.usage };
  }

  get callCount(): number {
    return this.cursor;
  }
}

let callSeq = 0;
export function toolCall(name: string, args: Record<string, unknown>): ModelResponse["toolCalls"][number] {
  return { id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) };
}
