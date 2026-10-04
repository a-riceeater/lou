import { LouError } from "@lou/shared";
import type { ModelToolSpec } from "@lou/tools";
import type { z } from "zod";

/**
 * Provider-neutral model interface. Nothing outside a provider implementation
 * knows about OpenAI request shapes, so the runtime (or the whole runtime, e.g.
 * Hermes) can be swapped without touching the rest of the system.
 */
export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as produced by the model. */
  arguments: string;
}

export type ModelPurpose = "agent" | "classify" | "draft" | "evaluate" | "summarize";

export interface ModelRequest {
  purpose: ModelPurpose;
  /** Overrides the provider's default model. */
  model?: string;
  messages: ModelMessage[];
  tools?: ModelToolSpec[];
  /** Ask for JSON matching this schema (structured output). */
  responseFormat?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  /** Stable key that helps provider-side prompt caching. */
  cacheKey?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  model: string;
  usage?: ModelUsage;
}

export interface ModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

/** Runs a structured-output request and validates the JSON against a zod schema. */
export async function completeStructured<T>(
  provider: ModelProvider,
  request: Omit<ModelRequest, "responseFormat" | "tools"> & { schemaName: string; jsonSchema: Record<string, unknown> },
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { schemaName, jsonSchema, ...rest } = request;
  const response = await provider.complete({ ...rest, responseFormat: { name: schemaName, schema: jsonSchema } }, signal);
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(response.text));
  } catch {
    throw new LouError("MODEL_ERROR", `Model returned invalid JSON for ${schemaName}.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new LouError("MODEL_ERROR", `Model output did not match ${schemaName}: ${parsed.error.message}`);
  return parsed.data;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Chooses which model handles a request. Luna by default; an optional stronger
 * model only on concrete escalation signals (never message length alone).
 */
export interface EscalationSignals {
  consecutiveToolFailures: number;
}

export class ModelRouter {
  constructor(
    readonly primary: ModelProvider,
    private readonly escalation?: { provider: ModelProvider; model?: string; afterToolFailures: number },
  ) {}

  select(signals: EscalationSignals): { provider: ModelProvider; model: string } {
    if (this.escalation && signals.consecutiveToolFailures >= this.escalation.afterToolFailures) {
      return { provider: this.escalation.provider, model: this.escalation.model ?? this.escalation.provider.defaultModel };
    }
    return { provider: this.primary, model: this.primary.defaultModel };
  }
}
