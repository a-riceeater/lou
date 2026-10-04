import type { SerializedError } from "@lou/shared";
import type { ToolCallRecord } from "@lou/tools";
import { eq } from "drizzle-orm";
import type { ApprovalManager } from "../approvals/manager";
import type { AuditLog } from "../core/audit";
import type { Db } from "../db/client";
import { toolCalls } from "../db/schema";

const MAX_STORED_OUTPUT = 20_000;

/** Persists every tool call and writes the security audit trail for it. */
export class ToolCallRecorder {
  private readonly records = new Map<string, ToolCallRecord & { userId?: string }>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly approvals: ApprovalManager,
    private readonly userOfRun: (runId: string | undefined) => string | undefined,
  ) {}

  started(record: ToolCallRecord): void {
    this.records.set(record.id, { ...record, userId: this.userOfRun(record.runId) });
    this.db
      .insert(toolCalls)
      .values({
        id: record.id,
        runId: record.runId ?? null,
        toolId: record.toolId,
        input: record.input,
        status: "running",
        risk: record.risk,
        executionTarget: record.executionTarget,
        deviceId: record.deviceId ?? null,
        approvalId: record.approvalId ?? null,
      })
      .run();
  }

  finished(id: string, outcome: { status: "succeeded" | "failed" | "denied" | "awaiting_approval"; output?: unknown; error?: SerializedError; approvalId?: string }): void {
    const record = this.records.get(id);
    this.records.delete(id);
    this.db
      .update(toolCalls)
      .set({
        status: outcome.status,
        output: truncate(outcome.output),
        errorCode: outcome.error?.code ?? null,
        errorMessage: outcome.error?.message ?? null,
        approvalId: outcome.approvalId ?? record?.approvalId ?? null,
        finishedAt: outcome.status === "awaiting_approval" ? null : new Date().toISOString(),
      })
      .where(eq(toolCalls.id, id))
      .run();
    if (!record) return;

    const action =
      outcome.status === "denied"
        ? "tool.denied"
        : outcome.status === "awaiting_approval"
          ? "tool.approval_requested"
          : outcome.status === "failed"
            ? "tool.failed"
            : "tool.executed";
    // Read-only successes are high-volume; everything else is security relevant.
    if (record.risk !== "read" || outcome.status !== "succeeded") {
      this.audit.record({
        userId: record.userId,
        actorType: "agent",
        action,
        targetType: "tool",
        targetId: record.toolId,
        runId: record.runId,
        details: {
          toolCallId: id,
          risk: record.risk,
          target: record.executionTarget,
          deviceId: record.deviceId,
          approvalId: outcome.approvalId ?? record.approvalId,
          error: outcome.error ? { code: outcome.error.code, message: outcome.error.message } : undefined,
        },
      });
    } else {
      this.audit.record({ userId: record.userId, actorType: "agent", action, targetType: "tool", targetId: record.toolId, runId: record.runId, details: { toolCallId: id } });
    }

    if (record.approvalId && (outcome.status === "succeeded" || outcome.status === "failed")) {
      this.approvals.markExecuted(record.approvalId, { success: outcome.status === "succeeded", error: outcome.error });
    }
  }
}

function truncate(output: unknown): unknown {
  if (output === undefined) return null;
  const json = JSON.stringify(output);
  return json.length > MAX_STORED_OUTPUT ? { truncated: true, preview: json.slice(0, MAX_STORED_OUTPUT) } : output;
}
