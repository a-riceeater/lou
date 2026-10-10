import type { ProviderId, RunState, RunStore } from "@lou/agent";
import type { HistoryItem, HistoryOutcome, RunStatus, RunStepStatus, RunView } from "@lou/protocol";
import { TERMINAL_RUN_STATUSES } from "@lou/protocol";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { agentRuns, toolCalls } from "../db/schema";

/** SQLite-backed persistence of agent run state (model-visible state only). */
export class DbRunStore implements RunStore {
  constructor(
    private readonly db: Db,
    private readonly toolTitle: (toolId: string) => string,
  ) {}

  async create(state: RunState): Promise<void> {
    this.db
      .insert(agentRuns)
      .values({
        id: state.runId,
        userId: state.userId,
        conversationId: state.conversationId,
        deviceId: state.originDeviceId ?? null,
        source: state.source,
        status: state.status,
        request: state.request,
        model: state.model,
        provider: state.provider ?? "openai_api",
        state: state as unknown as Record<string, unknown>,
      })
      .run();
  }

  async save(state: RunState): Promise<void> {
    const terminal = TERMINAL_RUN_STATUSES.includes(state.status);
    this.db
      .update(agentRuns)
      .set({
        status: state.status,
        model: state.model,
        state: state as unknown as Record<string, unknown>,
        selectedSkills: state.loadedSkills,
        finalMessage: state.finalMessage,
        errorCode: state.error?.code ?? null,
        errorMessage: state.error?.message ?? null,
        pendingApprovalId: state.pending?.approvalId ?? null,
        actionsTaken: state.actionsTaken,
        updatedAt: new Date().toISOString(),
        completedAt: terminal ? new Date().toISOString() : null,
      })
      .where(eq(agentRuns.id, state.runId))
      .run();
  }

  async load(runId: string): Promise<RunState | undefined> {
    const row = this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    return row ? (row.state as unknown as RunState) : undefined;
  }

  /** Runs left mid-flight by a crash/restart are failed so they don't hang forever. */
  providerOf(runId: string): ProviderId | undefined {
    const row = this.db.select({ provider: agentRuns.provider }).from(agentRuns).where(eq(agentRuns.id, runId)).get();
    return row?.provider as ProviderId | undefined;
  }

  recoverInterrupted(): number {
    const result = this.db
      .update(agentRuns)
      .set({ status: "failed", errorCode: "INTERNAL", errorMessage: "The server restarted while this was running.", completedAt: new Date().toISOString() })
      .where(inArray(agentRuns.status, ["created", "reasoning", "waiting_for_tool", "resuming"]))
      .run();
    return result.changes;
  }

  view(userId: string, runId: string): RunView | undefined {
    const row = this.db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).get();
    if (!row) return undefined;
    const steps = this.db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(asc(toolCalls.startedAt)).all();
    return {
      id: row.id,
      conversationId: row.conversationId,
      status: row.status as RunStatus,
      request: row.request,
      finalMessage: row.finalMessage,
      error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? "" } : null,
      approvalId: row.pendingApprovalId,
      skills: row.selectedSkills,
      steps: steps.map((s) => ({
        id: s.id,
        toolId: s.toolId,
        label: this.toolTitle(s.toolId),
        status: s.status as RunStepStatus,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  history(userId: string, options: { limit?: number; before?: string }): HistoryItem[] {
    const where = options.before ? and(eq(agentRuns.userId, userId), lt(agentRuns.createdAt, options.before)) : eq(agentRuns.userId, userId);
    return this.db
      .select()
      .from(agentRuns)
      .where(where)
      .orderBy(desc(agentRuns.createdAt))
      .limit(Math.min(options.limit ?? 50, 200))
      .all()
      .map((r) => ({
        runId: r.id,
        request: r.request,
        status: r.status as RunStatus,
        summary: r.finalMessage ?? r.errorMessage,
        outcome: outcomeOf(r.status as RunStatus, r.actionsTaken, r.finalMessage),
        createdAt: r.createdAt,
      }));
  }

  recentRequests(userId: string, limit: number): Array<{ id: string; request: string }> {
    return this.db
      .select({ id: agentRuns.id, request: agentRuns.request })
      .from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.source, "user")))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
      .all();
  }
}

function outcomeOf(status: RunStatus, actions: number, finalMessage: string | null): HistoryOutcome {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status !== "completed") return "pending";
  if (actions > 0) return "action_taken";
  if (finalMessage && /cancel|expired/i.test(finalMessage) && finalMessage.length < 60) return "cancelled";
  return "answered";
}
