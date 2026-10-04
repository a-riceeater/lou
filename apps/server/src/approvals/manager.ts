import type { ApprovalStatus, ApprovalView, ResolveApprovalRequest } from "@lou/protocol";
import { LouError, newId, type SerializedError } from "@lou/shared";
import type { ApprovalCreateRequest, ToolRegistry } from "@lou/tools";
import { and, desc, eq, lt } from "drizzle-orm";
import type { AuditLog } from "../core/audit";
import type { EventBus } from "../core/bus";
import type { Db } from "../db/client";
import { approvals } from "../db/schema";
import { hashAction, safeEqual } from "../security/crypto";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type ApprovalRow = typeof approvals.$inferSelect;

export interface ApprovalDecision {
  approvalId: string;
  runId: string | null;
  workflowRunId: string | null;
  toolId: string;
  decision: "approved" | "rejected" | "expired";
  /** Final input (proposed + validated edits). Present when approved. */
  input?: Record<string, unknown>;
  inputHash?: string;
}

export type DecisionHandler = (decision: ApprovalDecision) => Promise<void>;

/**
 * Approval integrity (SECURITY.md §8):
 * - the proposed action is immutable and identified by `actionHash`;
 * - the client must echo the hash it displayed, so stale or swapped approvals fail;
 * - only declared editable fields may change, producing a new final action + hash;
 * - the executor only runs a call whose input hash equals the approved final hash;
 * - pending → approved is an atomic transition, so two devices cannot both approve.
 */
export class ApprovalManager {
  private handler: DecisionHandler | undefined;

  constructor(
    private readonly db: Db,
    private readonly registry: ToolRegistry,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  onDecision(handler: DecisionHandler): void {
    this.handler = handler;
  }

  async create(req: ApprovalCreateRequest & { workflowRunId?: string }): Promise<{ approvalId: string }> {
    const id = newId("apr");
    const editable = new Set(req.editableFields);
    // Editable values are always taken from the actual input, never from display text.
    const fields = req.presentation.fields.map((f) =>
      editable.has(f.key) && typeof req.input[f.key] === "string" ? { ...f, value: req.input[f.key] as string } : f,
    );
    this.db
      .insert(approvals)
      .values({
        id,
        userId: req.userId,
        runId: req.runId ?? null,
        workflowRunId: req.workflowRunId ?? null,
        toolCallId: req.toolCallId ?? null,
        toolId: req.toolId,
        kind: req.presentation.kind,
        title: req.presentation.title,
        summary: req.presentation.summary ?? null,
        account: req.presentation.account ?? null,
        fields,
        proposedInput: req.input,
        actionHash: req.inputHash,
        editableFields: [...req.editableFields],
        risk: req.risk,
        reasons: req.reasons,
        tainted: req.tainted,
        expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
      })
      .run();
    this.audit.record({
      userId: req.userId,
      actorType: "agent",
      action: "approval.created",
      targetType: "approval",
      targetId: id,
      runId: req.runId,
      details: { toolId: req.toolId, risk: req.risk, reasons: req.reasons, actionHash: req.inputHash, tainted: req.tainted },
    });
    const view = this.view(req.userId, id);
    if (view) this.bus.emit("approval.requested", { userId: req.userId, approval: view });
    return { approvalId: id };
  }

  view(userId: string, id: string): ApprovalView | undefined {
    const row = this.db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.userId, userId))).get();
    return row ? toView(row) : undefined;
  }

  list(userId: string, status?: ApprovalStatus, limit = 50): ApprovalView[] {
    const where = status ? and(eq(approvals.userId, userId), eq(approvals.status, status)) : eq(approvals.userId, userId);
    return this.db.select().from(approvals).where(where).orderBy(desc(approvals.createdAt)).limit(limit).all().map(toView);
  }

  async resolve(userId: string, id: string, req: ResolveApprovalRequest, actor: { deviceId?: string }): Promise<ApprovalView> {
    const row = this.db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.userId, userId))).get();
    if (!row) throw new LouError("NOT_FOUND", "Approval not found.");
    if (row.status !== "pending") throw new LouError("CONFLICT", `This request was already ${row.status}.`);
    if (row.expiresAt && row.expiresAt < new Date().toISOString()) {
      await this.expire(row);
      throw new LouError("APPROVAL_EXPIRED", "This request expired.");
    }
    if (!safeEqual(req.actionHash, row.actionHash)) {
      this.audit.record({
        userId,
        actorType: "device",
        actorId: actor.deviceId,
        action: "approval.integrity_failure",
        targetType: "approval",
        targetId: id,
        runId: row.runId,
        details: { reason: "action_hash_mismatch" },
      });
      throw new LouError("APPROVAL_MISMATCH", "The request changed since it was shown. Review it again.");
    }

    if (req.decision === "reject") {
      if (!this.transition(id, { status: "rejected", resolvedByDeviceId: actor.deviceId ?? null, resolvedAt: new Date().toISOString() })) {
        throw new LouError("CONFLICT", "This request was already resolved.");
      }
      this.audit.record({ userId, actorType: "device", actorId: actor.deviceId, action: "approval.rejected", targetType: "approval", targetId: id, runId: row.runId });
      this.bus.emit("approval.resolved", { userId, approvalId: id, status: "rejected", runId: row.runId });
      await this.dispatch({ approvalId: id, runId: row.runId, workflowRunId: row.workflowRunId, toolId: row.toolId, decision: "rejected" });
      return this.view(userId, id)!;
    }

    const finalInput = this.applyEdits(row, req.edits ?? {});
    const finalHash = hashAction(finalInput);
    const edited = finalHash !== row.actionHash;
    if (
      !this.transition(id, {
        status: "approved",
        finalInput,
        finalHash,
        edited,
        resolvedByDeviceId: actor.deviceId ?? null,
        resolvedAt: new Date().toISOString(),
      })
    ) {
      throw new LouError("CONFLICT", "This request was already resolved.");
    }
    this.audit.record({
      userId,
      actorType: "device",
      actorId: actor.deviceId,
      action: "approval.approved",
      targetType: "approval",
      targetId: id,
      runId: row.runId,
      details: { toolId: row.toolId, edited, editedFields: Object.keys(req.edits ?? {}).filter((k) => req.edits?.[k] !== row.proposedInput[k]), finalHash },
    });
    this.bus.emit("approval.resolved", { userId, approvalId: id, status: "approved", runId: row.runId });
    await this.dispatch({
      approvalId: id,
      runId: row.runId,
      workflowRunId: row.workflowRunId,
      toolId: row.toolId,
      decision: "approved",
      input: finalInput,
      inputHash: finalHash,
    });
    return this.view(userId, id)!;
  }

  /** Called when the approved tool call finishes executing. */
  markExecuted(approvalId: string, outcome: { success: boolean; error?: SerializedError }): void {
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!row || row.status !== "approved") return;
    const status = outcome.success ? "executed" : "failed";
    this.db
      .update(approvals)
      .set({ status, executedAt: new Date().toISOString(), errorCode: outcome.error?.code ?? null, errorMessage: outcome.error?.message ?? null })
      .where(eq(approvals.id, approvalId))
      .run();
    this.audit.record({
      userId: row.userId,
      actorType: "system",
      action: outcome.success ? "approval.executed" : "approval.execution_failed",
      targetType: "approval",
      targetId: approvalId,
      runId: row.runId,
      details: outcome.error ? { code: outcome.error.code } : {},
    });
    this.bus.emit("approval.resolved", { userId: row.userId, approvalId, status, runId: row.runId });
  }

  /** Expires a pending approval for a run that was cancelled. */
  async cancelForRun(runId: string): Promise<void> {
    const rows = this.db.select().from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.status, "pending"))).all();
    for (const row of rows) {
      if (this.transition(row.id, { status: "expired", resolvedAt: new Date().toISOString() })) {
        this.bus.emit("approval.resolved", { userId: row.userId, approvalId: row.id, status: "expired", runId: row.runId });
      }
    }
  }

  async expireStale(): Promise<number> {
    const rows = this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, new Date().toISOString())))
      .all();
    for (const row of rows) await this.expire(row);
    return rows.length;
  }

  private async expire(row: ApprovalRow): Promise<void> {
    if (!this.transition(row.id, { status: "expired", resolvedAt: new Date().toISOString() })) return;
    this.audit.record({ userId: row.userId, actorType: "system", action: "approval.expired", targetType: "approval", targetId: row.id, runId: row.runId });
    this.bus.emit("approval.resolved", { userId: row.userId, approvalId: row.id, status: "expired", runId: row.runId });
    await this.dispatch({ approvalId: row.id, runId: row.runId, workflowRunId: row.workflowRunId, toolId: row.toolId, decision: "expired" });
  }

  private applyEdits(row: ApprovalRow, edits: Record<string, string>): Record<string, unknown> {
    const allowed = new Set(row.editableFields);
    for (const key of Object.keys(edits)) {
      if (!allowed.has(key)) throw new LouError("VALIDATION_FAILED", `"${key}" cannot be edited for this action.`);
    }
    const handler = this.registry.has(row.toolId) ? this.registry.handler(row.toolId) : undefined;
    const merged = handler?.applyEdits ? handler.applyEdits(row.proposedInput, edits) : { ...row.proposedInput, ...edits };
    const def = this.registry.get(row.toolId);
    const schema = def?.preparedInput ?? def?.input;
    if (schema) {
      const parsed = schema.safeParse(merged);
      if (!parsed.success) throw new LouError("VALIDATION_FAILED", parsed.error.issues.map((i) => i.message).join("; "));
      // Guard: non-editable keys must be byte-identical to the proposal.
      for (const [key, value] of Object.entries(row.proposedInput)) {
        if (!allowed.has(key) && hashAction(value) !== hashAction((merged as Record<string, unknown>)[key])) {
          throw new LouError("APPROVAL_MISMATCH", `"${key}" changed during editing.`);
        }
      }
      return merged as Record<string, unknown>;
    }
    return merged;
  }

  private transition(id: string, set: Partial<typeof approvals.$inferInsert>): boolean {
    return this.db.update(approvals).set(set).where(and(eq(approvals.id, id), eq(approvals.status, "pending"))).run().changes === 1;
  }

  private async dispatch(decision: ApprovalDecision): Promise<void> {
    if (!this.handler) return;
    await this.handler(decision);
  }
}

function toView(row: ApprovalRow): ApprovalView {
  const editable = new Set(row.editableFields);
  const warnings: string[] = [];
  if (row.tainted) warnings.push("Drafted after reading external content. Check it before approving.");
  if (row.risk === "destructive") warnings.push("This can't be undone.");
  if (row.risk === "privileged") warnings.push("This is a privileged action.");
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    account: row.account,
    fields: row.fields.map((f) => ({ key: f.key, label: f.label, value: f.value, editable: editable.has(f.key), kind: f.kind as "text" | "longtext" | "recipients" })),
    risk: row.risk as ApprovalView["risk"],
    status: row.status as ApprovalStatus,
    actionHash: row.actionHash,
    warnings,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? "" } : null,
  };
}
