import { LouError } from "@lou/shared";
import OpenAI from "openai";
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "./model";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  organization?: string;
  /** Overrides for specific purposes, e.g. a cheaper classifier. */
  purposeModels?: Partial<Record<ModelRequest["purpose"], string>>;
  maxRetries?: number;
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
}

/**
 * OpenAI Responses API provider (default model: GPT-6 Luna).
 *
 * - `store: false`: conversation state lives in our database, not at OpenAI.
 * - Reasoning items are never requested or persisted (no hidden chain-of-thought).
 * - Tool names are mapped because the API forbids dots (`gmail.search` → `gmail__search`).
 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = "openai";
  readonly defaultModel: string;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.defaultModel = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      organization: options.organization,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 90_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const model = request.model ?? this.options.purposeModels?.[request.purpose] ?? this.defaultModel;
    const nameMap = new Map<string, string>();
    const tools = request.tools?.map((t) => {
      const apiName = toApiName(t.name);
      nameMap.set(apiName, t.name);
      return { type: "function" as const, name: apiName, description: t.description, parameters: t.parameters, strict: false };
    });

    const params: Record<string, unknown> = {
      model,
      input: toInput(request.messages),
      store: false,
      ...(tools?.length ? { tools, parallel_tool_calls: true } : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      ...(request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
      ...(request.responseFormat
        ? { text: { format: { type: "json_schema", name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true } } }
        : {}),
    };

    let response: OpenAI.Responses.Response;
    try {
      response = (await this.client.responses.create(params as never, { signal })) as OpenAI.Responses.Response;
    } catch (err) {
      throw mapError(err);
    }

    if (response.status === "failed" || response.error) {
      throw new LouError("MODEL_ERROR", response.error?.message ?? "The model request failed.");
    }

    const toolCalls: ModelToolCall[] = [];
    let text = "";
    for (const item of response.output ?? []) {
      if (item.type === "function_call") {
        toolCalls.push({ id: item.call_id, name: nameMap.get(item.name) ?? fromApiName(item.name), arguments: item.arguments });
      } else if (item.type === "message") {
        for (const part of item.content) if (part.type === "output_text") text += part.text;
      }
    }

    const usage = response.usage;
    return {
      text,
      toolCalls,
      model: response.model ?? model,
      usage: usage
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          }
        : undefined,
    };
  }
}

export function toApiName(name: string): string {
  return name.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function fromApiName(name: string): string {
  return name.replace(/__/g, ".");
}

function toInput(messages: ModelMessage[]): unknown[] {
  const items: unknown[] = [];
  let systemSeen = false;
  for (const m of messages) {
    switch (m.role) {
      case "system":
        // First system message = stable instructions; later ones = per-run developer context.
        items.push({ role: systemSeen ? "developer" : "system", content: m.content });
        systemSeen = true;
        break;
      case "user":
        items.push({ role: "user", content: m.content });
        break;
      case "assistant":
        if (m.content) items.push({ role: "assistant", content: m.content });
        for (const call of m.toolCalls ?? []) {
          items.push({ type: "function_call", call_id: call.id, name: toApiName(call.name), arguments: call.arguments });
        }
        break;
      case "tool":
        items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return items;
}

function mapError(err: unknown): LouError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) return new LouError("NOT_CONFIGURED", "The OpenAI API key was rejected.", { cause: err });
    if (status === 429) return new LouError("RATE_LIMITED", "The model is rate limited. Try again shortly.", { cause: err });
    if (status === 404) return new LouError("NOT_CONFIGURED", `Model not available: ${err.message}`, { cause: err });
    if (status >= 500) return new LouError("UPSTREAM_ERROR", "The model service is unavailable.", { cause: err });
    return new LouError("MODEL_ERROR", err.message, { cause: err });
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
    return new LouError("CANCELLED", "The model request was cancelled.", { cause: err });
  }
  return new LouError("MODEL_ERROR", err instanceof Error ? err.message : String(err), { cause: err });
}
