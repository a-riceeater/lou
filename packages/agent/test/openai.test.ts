import { describe, expect, it } from "vitest";
import { OpenAIResponsesProvider } from "../src";

/** Captures the Responses API request and returns a canned response. */
function mockFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OpenAIResponsesProvider", () => {
  it("maps tools, transcript items and function calls without persisting state at OpenAI", async () => {
    const { calls, fetchImpl } = mockFetch({
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-6-luna",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", id: "fc_1", call_id: "call_9", name: "gmail__read_thread", arguments: '{"threadId":"t1"}', status: "completed" },
      ],
      usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 0 } },
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test", model: "gpt-6-luna", fetch: fetchImpl, maxRetries: 0 });
    const res = await provider.complete({
      purpose: "agent",
      messages: [
        { role: "system", content: "stable instructions" },
        { role: "system", content: "per-run context" },
        { role: "user", content: "reply to sarah" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "gmail.search", arguments: '{"query":"from:sarah"}' }] },
        { role: "tool", toolCallId: "call_1", name: "gmail.search", content: "<external_data>…</external_data>" },
      ],
      tools: [
        { name: "gmail.search", description: "Search", parameters: { type: "object", properties: { query: { type: "string" } } } },
        { name: "gmail.read_thread", description: "Read", parameters: { type: "object", properties: {} } },
      ],
      cacheKey: "lou-agent-usr_1",
    });

    const body = calls[0]!.body;
    expect(calls[0]!.url).toMatch(/\/responses$/);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.store).toBe(false);
    expect(body.prompt_cache_key).toBe("lou-agent-usr_1");
    expect(body.tools.map((t: any) => t.name)).toEqual(["gmail__search", "gmail__read_thread"]);
    expect(body.input).toEqual([
      { role: "system", content: "stable instructions" },
      { role: "developer", content: "per-run context" },
      { role: "user", content: "reply to sarah" },
      { type: "function_call", call_id: "call_1", name: "gmail__search", arguments: '{"query":"from:sarah"}' },
      { type: "function_call_output", call_id: "call_1", output: "<external_data>…</external_data>" },
    ]);
    // Reasoning items are ignored; dotted tool names restored.
    expect(res.toolCalls).toEqual([{ id: "call_9", name: "gmail.read_thread", arguments: '{"threadId":"t1"}' }]);
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1000 });
  });

  it("requests strict JSON schema output for structured tasks", async () => {
    const { calls, fetchImpl } = mockFetch({
      id: "resp_2",
      object: "response",
      status: "completed",
      model: "gpt-6-luna",
      output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"body":"hi"}', annotations: [] }] }],
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test", model: "gpt-6-luna", fetch: fetchImpl, maxRetries: 0 });
    const res = await provider.complete({ purpose: "draft", messages: [{ role: "user", content: "x" }], responseFormat: { name: "draft", schema: { type: "object" } } });
    expect(calls[0]!.body.text.format).toMatchObject({ type: "json_schema", name: "draft", strict: true });
    expect(res.text).toBe('{"body":"hi"}');
  });

  it("maps API failures to structured errors", async () => {
    const { fetchImpl } = mockFetch({ error: { message: "bad key", type: "invalid_request_error" } }, 401);
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-bad", model: "gpt-6-luna", fetch: fetchImpl, maxRetries: 0 });
    await expect(provider.complete({ purpose: "agent", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("OpenAIResponsesProvider streaming", () => {
  it("streams text deltas over SSE and returns the completed response", async () => {
    const completed = {
      id: "resp_3",
      object: "response",
      status: "completed",
      model: "gpt-6-luna",
      output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello there.", annotations: [] }] }],
    };
    const events = [
      { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "there." },
      { type: "response.completed", response: completed },
    ];
    const bodies: any[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test", model: "gpt-6-luna", fetch: fetchImpl, maxRetries: 0 });
    const deltas: string[] = [];
    const res = await provider.complete({ purpose: "agent", messages: [{ role: "user", content: "hi" }], onTextDelta: (t) => deltas.push(t) });
    expect(bodies[0].stream).toBe(true);
    expect(deltas).toEqual(["Hello ", "there."]);
    expect(res.text).toBe("Hello there.");
  });
});
