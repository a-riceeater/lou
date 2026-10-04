import { LouError } from "@lou/shared";
import type { CodexAppServerManager } from "./appServer";
import { FORBIDDEN_ITEM_TYPES, type JsonValue, type RpcNotification, type ThreadItem, type Turn, type TurnError, type TurnStatus } from "./protocol";

export interface TurnObserver {
  onTurnStarted?(turnId: string): void;
  onDelta?(text: string): void;
  onItemStarted?(item: ThreadItem): void;
}

export interface TurnResult {
  turnId: string;
  status: TurnStatus;
  /** Final assistant message for the turn. */
  text: string;
  error: TurnError | null;
}

export interface RunTurnOptions {
  threadId: string;
  text: string;
  model?: string;
  outputSchema?: JsonValue;
  signal?: AbortSignal;
  timeoutMs?: number;
  observer?: TurnObserver;
}

/**
 * Runs one App Server turn and maps its event stream to provider-neutral
 * callbacks. A turn succeeds only when the protocol reports `completed`.
 * Codex-native capabilities (shell, patches, MCP, web, sub-agents) are disabled
 * at launch; if one shows up anyway, the turn is interrupted and rejected.
 */
export async function runCodexTurn(manager: CodexAppServerManager, options: RunTurnOptions): Promise<TurnResult> {
  const { threadId, signal } = options;
  if (signal?.aborted) throw new LouError("CANCELLED", "Cancelled.");

  let turnId: string | null = null;
  let finalText = "";
  let streamed = "";
  let violation: string | null = null;
  let settle!: { resolve(r: TurnResult): void; reject(e: Error): void };
  const done = new Promise<TurnResult>((resolve, reject) => (settle = { resolve, reject }));

  const interrupt = () => {
    if (turnId) void manager.interruptTurn(threadId, turnId);
  };

  const offNotify = manager.onNotification((n: RpcNotification) => {
    const p = (n.params ?? {}) as { threadId?: string; turnId?: string; turn?: Turn; item?: ThreadItem; delta?: string; error?: TurnError; willRetry?: boolean };
    if (p.threadId !== threadId) return;
    switch (n.method) {
      case "turn/started":
        turnId ??= p.turn?.id ?? null;
        if (turnId) options.observer?.onTurnStarted?.(turnId);
        break;
      case "item/started":
        if (p.item && FORBIDDEN_ITEM_TYPES.has(p.item.type)) {
          violation = p.item.type;
          interrupt();
        } else if (p.item) options.observer?.onItemStarted?.(p.item);
        break;
      case "item/agentMessage/delta":
        if (typeof p.delta === "string") {
          streamed += p.delta;
          options.observer?.onDelta?.(p.delta);
        }
        break;
      case "item/completed":
        if (p.item?.type === "agentMessage" && typeof p.item.text === "string" && p.item.phase !== "commentary") finalText = p.item.text;
        break;
      case "turn/completed": {
        const turn = p.turn;
        if (!turn) break;
        const fromItems = [...(turn.items ?? [])].reverse().find((i) => i.type === "agentMessage" && typeof i.text === "string")?.text;
        settle.resolve({ turnId: turn.id, status: turn.status, text: (finalText || fromItems || streamed).trim(), error: turn.error ?? null });
        break;
      }
    }
  });
  const offExit = manager.onExit((reason) => settle.reject(new LouError("UPSTREAM_ERROR", reason, { retryable: true })));

  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    interrupt();
    // If Codex doesn't confirm the interruption, give up anyway.
    setTimeout(() => settle.reject(new LouError("TIMEOUT", "Codex took too long to respond.")), 5000).unref?.();
  }, timeoutMs);
  const onAbort = () => {
    interrupt();
    setTimeout(() => settle.reject(new LouError("CANCELLED", "Cancelled.")), 5000).unref?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const turn = await manager.startTurn({
      threadId,
      input: [{ type: "text", text: options.text, text_elements: [] }],
      ...(options.model ? { model: options.model } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    });
    turnId ??= turn.id;
    if (signal?.aborted) interrupt();
    const result = await done;
    if (violation) throw new LouError("POLICY_DENIED", `Codex tried to use a capability Lou doesn't allow (${violation}); the request was stopped.`);
    if (timedOut) throw new LouError("TIMEOUT", "Codex took too long to respond.");
    if (signal?.aborted || result.status === "interrupted") {
      if (signal?.aborted) throw new LouError("CANCELLED", "Cancelled.");
    }
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    offNotify();
    offExit();
  }
}
