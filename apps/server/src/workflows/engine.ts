import { draftReply, type ModelProvider } from "@lou/agent";
import type { WorkflowSummary } from "@lou/protocol";
import { LouError, newId, toLouError, type SerializedError } from "@lou/shared";
import type { ToolExecutor, ToolRegistry } from "@lou/tools";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditLog } from "../core/audit";
import type { Db } from "../db/client";
import { workflowRuns, workflows, workflowVersions } from "../db/schema";
import type { Logger } from "../logger";

/**
 * Structured workflows: deterministic, versioned step sequences (ARCHITECTURE.md
 * §3.5). The model may choose to run a workflow; the engine executes the fixed
 * steps. Every tool step goes through the ToolExecutor, so policy and approvals
 * apply exactly as for model calls; an approval-gated step pauses the workflow.
 */
const Template = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Template = z.infer<typeof Template>;

export const WorkflowStepSchema = z.union([
  z.object({ id: z.string(), tool: z.string(), input: z.record(z.string(), Template).default({}) }),
  z.object({ id: z.string(), model: z.literal("draft_reply"), input: z.record(z.string(), Template) }),
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string(),
  description: z.string(),
  inputs: z.record(z.string(), z.object({ description: z.string(), required: z.boolean().default(true) })),
  steps: z.array(WorkflowStepSchema).min(1).max(20),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

interface WorkflowState {
  inputs: Record<string, unknown>;
  steps: Record<string, unknown>;
  tainted?: boolean;
  originDeviceId?: string;
  [key: string]: unknown;
}

export interface WorkflowResult {
  workflowRunId: string;
  status: "completed" | "waiting_for_approval" | "failed" | "cancelled";
  approvalId?: string;
  output?: unknown;
  error?: SerializedError;
}

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "reply-to-email",
    name: "Reply to email",
    description: "Read a Gmail thread, draft a reply following an instruction, ask for approval, then send.",
    inputs: {
      threadId: { description: "Gmail thread ID", required: true },
      instruction: { description: "What the reply should say", required: true },
      accountId: { description: "Gmail account ID", required: false },
    },
    steps: [
      { id: "read", tool: "gmail.read_thread", input: { accountId: "{{inputs.accountId}}", threadId: "{{inputs.threadId}}" } },
      { id: "draft", model: "draft_reply", input: { instruction: "{{inputs.instruction}}", thread: "{{steps.read}}" } },
      { id: "send", tool: "gmail.reply", input: { accountId: "{{inputs.accountId}}", messageId: "{{steps.read.messages.-1.id}}", body: "{{steps.draft.body}}" } },
    ],
  },
];

export class WorkflowEngine {
  constructor(
    private readonly db: Db,
    private readonly registry: ToolRegistry,
    private readonly executor: () => ToolExecutor,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly model?: ModelProvider,
    private readonly userName: () => string = () => "the user",
  ) {}

  syncBuiltins(): void {
    for (const def of BUILTIN_WORKFLOWS) {
      const existing = this.db.select().from(workflows).where(eq(workflows.id, def.id)).get();
      const latest = this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, def.id)).orderBy(desc(workflowVersions.version)).get();
      if (latest && JSON.stringify(latest.definition) === JSON.stringify(def)) continue;
      const version = (latest?.version ?? 0) + 1;
      if (!existing) this.db.insert(workflows).values({ id: def.id, name: def.name, description: def.description, origin: "builtin", activeVersion: version }).run();
      else this.db.update(workflows).set({ activeVersion: version, name: def.name, description: def.description }).where(eq(workflows.id, def.id)).run();
      this.db.update(workflowVersions).set({ status: "deprecated" }).where(eq(workflowVersions.workflowId, def.id)).run();
      this.db.insert(workflowVersions).values({ id: newId("wfv"), workflowId: def.id, version, definition: def, status: "active", createdBy: "builtin" }).run();
    }
  }

  list(): WorkflowSummary[] {
    return this.db
      .select()
      .from(workflows)
      .all()
      .map((w) => {
        const def = this.definition(w.id);
        return { id: w.id, name: w.name, description: w.description, version: w.activeVersion ?? 0, enabled: w.enabled, origin: w.origin as WorkflowSummary["origin"], steps: def?.steps.length ?? 0 };
      });
  }

  /** Validates a proposed workflow (tools exist, templates parse). Activation is a separate, approved step. */
  propose(def: unknown, meta: { createdBy: "agent" | "user"; sourceRunId?: string; reason?: string }): { workflowId: string; version: number } {
    const parsed = WorkflowDefinitionSchema.parse(def);
    for (const step of parsed.steps) {
      if ("tool" in step && !this.registry.has(step.tool)) throw new LouError("VALIDATION_FAILED", `Unknown tool "${step.tool}" in workflow.`);
      if ("tool" in step && this.registry.get(step.tool)?.exposure === "internal") throw new LouError("VALIDATION_FAILED", `Workflow cannot use internal tool "${step.tool}".`);
    }
    if (!this.db.select().from(workflows).where(eq(workflows.id, parsed.id)).get()) {
      this.db.insert(workflows).values({ id: parsed.id, name: parsed.name, description: parsed.description, origin: meta.createdBy, enabled: false }).run();
    }
    const max = this.db.select({ v: sql<number>`coalesce(max(${workflowVersions.version}), 0)` }).from(workflowVersions).where(eq(workflowVersions.workflowId, parsed.id)).get();
    const version = (max?.v ?? 0) + 1;
    this.db.insert(workflowVersions).values({ id: newId("wfv"), workflowId: parsed.id, version, definition: parsed, status: "proposed", createdBy: meta.createdBy, sourceRunId: meta.sourceRunId ?? null, reason: meta.reason ?? null }).run();
    this.audit.record({ actorType: meta.createdBy === "agent" ? "agent" : "user", action: "workflow.proposed", targetType: "workflow", targetId: parsed.id, runId: meta.sourceRunId, details: { version } });
    return { workflowId: parsed.id, version };
  }

  definition(workflowId: string): WorkflowDefinition | undefined {
    const wf = this.db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
    if (!wf?.activeVersion) return undefined;
    const v = this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).all().find((x) => x.version === wf.activeVersion);
    return v ? WorkflowDefinitionSchema.parse(v.definition) : undefined;
  }

  async start(input: { userId: string; workflowId: string; inputs: Record<string, unknown>; agentRunId?: string; originDeviceId?: string; tainted: boolean; signal: AbortSignal }): Promise<WorkflowResult> {
    const wf = this.db.select().from(workflows).where(eq(workflows.id, input.workflowId)).get();
    const def = this.definition(input.workflowId);
    if (!wf || !def || !wf.enabled) throw new LouError("NOT_FOUND", `No enabled workflow "${input.workflowId}".`);
    for (const [name, spec] of Object.entries(def.inputs)) {
      if (spec.required && (input.inputs[name] === undefined || input.inputs[name] === "")) throw new LouError("VALIDATION_FAILED", `Missing workflow input "${name}".`);
    }
    const id = newId("wfr");
    const state: WorkflowState = { inputs: input.inputs, steps: {} };
    this.db
      .insert(workflowRuns)
      .values({ id, userId: input.userId, workflowId: def.id, version: wf.activeVersion!, agentRunId: input.agentRunId ?? null, status: "running", state: { ...state, tainted: input.tainted, originDeviceId: input.originDeviceId } })
      .run();
    this.audit.record({ userId: input.userId, actorType: "agent", action: "workflow.started", targetType: "workflow", targetId: def.id, runId: input.agentRunId, details: { workflowRunId: id } });
    return this.advance(id, input.signal);
  }

  /** Continues a workflow paused on an approval. */
  async resumeAfterApproval(workflowRunId: string, decision: { decision: "approved" | "rejected" | "expired"; approvalId: string; input?: Record<string, unknown>; inputHash?: string }): Promise<WorkflowResult> {
    const run = this.db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).get();
    if (!run || run.status !== "waiting_for_approval" || run.pendingApprovalId !== decision.approvalId) throw new LouError("CONFLICT", "Workflow is not waiting for this approval.");
    if (decision.decision !== "approved") {
      this.finish(workflowRunId, "cancelled");
      return { workflowRunId, status: "cancelled" };
    }
    const def = this.versionDef(run.workflowId, run.version);
    const step = def.steps[run.stepIndex];
    if (!step || !("tool" in step)) throw new LouError("INTERNAL", "Workflow approval step mismatch.");
    const st = run.state as unknown as WorkflowState;
    const outcome = await this.executor().invoke({
      toolId: step.tool,
      rawInput: decision.input,
      caller: "workflow",
      userId: run.userId,
      runId: run.agentRunId ?? undefined,
      originDeviceId: st.originDeviceId,
      tainted: !!st.tainted,
      grant: { approvalId: decision.approvalId, toolId: step.tool, inputHash: decision.inputHash ?? "" },
      signal: new AbortController().signal,
    });
    if (outcome.kind !== "result" || !outcome.result.success) {
      const error = outcome.kind === "denied" ? outcome.error : outcome.kind === "result" && !outcome.result.success ? outcome.result.error : { code: "INTERNAL" as const, message: "Unexpected approval state", retryable: false };
      this.finish(workflowRunId, "failed", error);
      return { workflowRunId, status: "failed", error };
    }
    st.steps[step.id] = outcome.result.data;
    this.db.update(workflowRuns).set({ state: st, stepIndex: run.stepIndex + 1, status: "running", pendingApprovalId: null, updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, workflowRunId)).run();
    return this.advance(workflowRunId, new AbortController().signal);
  }

  private async advance(workflowRunId: string, signal: AbortSignal): Promise<WorkflowResult> {
    const run = this.db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).get()!;
    const def = this.versionDef(run.workflowId, run.version);
    const st = run.state as unknown as WorkflowState;
    let index = run.stepIndex;
    try {
      for (; index < def.steps.length; index++) {
        if (signal.aborted) throw new LouError("CANCELLED", "Cancelled.");
        const step = def.steps[index]!;
        const resolved = resolveTemplates(step.input, st);
        if ("model" in step) {
          if (!this.model) throw new LouError("NOT_CONFIGURED", "No model is configured for drafting.");
          const body = await draftReply(this.model, { instruction: String(resolved.instruction ?? ""), thread: typeof resolved.thread === "string" ? resolved.thread : JSON.stringify(resolved.thread), userName: this.userName(), preferences: [] }, signal);
          st.steps[step.id] = { body };
          // Drafting from a thread means external content was read.
          st.tainted = true;
        } else {
          const outcome = await this.executor().invoke({
            toolId: step.tool,
            rawInput: dropUndefined(resolved),
            caller: "workflow",
            userId: run.userId,
            runId: run.agentRunId ?? undefined,
            originDeviceId: st.originDeviceId,
            tainted: !!st.tainted,
            signal,
          });
          if (outcome.kind === "approval_required") {
            this.db.update(workflowRuns).set({ state: st, stepIndex: index, status: "waiting_for_approval", pendingApprovalId: outcome.approvalId, updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, workflowRunId)).run();
            // Bind the approval to this workflow run so resolution resumes it.
            this.onApprovalLinked?.(outcome.approvalId, workflowRunId);
            return { workflowRunId, status: "waiting_for_approval", approvalId: outcome.approvalId };
          }
          if (outcome.kind === "denied") throw new LouError(outcome.error.code, outcome.error.message);
          if (!outcome.result.success) throw new LouError(outcome.result.error.code, outcome.result.error.message);
          if (outcome.definition.untrustedOutput) st.tainted = true;
          st.steps[step.id] = outcome.result.data;
        }
        this.db.update(workflowRuns).set({ state: st, stepIndex: index + 1, updatedAt: new Date().toISOString() }).where(eq(workflowRuns.id, workflowRunId)).run();
      }
      this.finish(workflowRunId, "completed");
      return { workflowRunId, status: "completed", output: st.steps[def.steps.at(-1)!.id] };
    } catch (err) {
      const error = toLouError(err).toJSON();
      this.finish(workflowRunId, error.code === "CANCELLED" ? "cancelled" : "failed", error);
      this.logger.warn({ workflowRunId, code: error.code }, "workflow step failed");
      return { workflowRunId, status: error.code === "CANCELLED" ? "cancelled" : "failed", error };
    }
  }

  /** Set by the app wiring: links a workflow-created approval to its workflow run. */
  onApprovalLinked?: (approvalId: string, workflowRunId: string) => void;

  private versionDef(workflowId: string, version: number): WorkflowDefinition {
    const v = this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).all().find((x) => x.version === version);
    if (!v) throw new LouError("NOT_FOUND", "Workflow version missing.");
    return WorkflowDefinitionSchema.parse(v.definition);
  }

  private finish(workflowRunId: string, status: string, error?: SerializedError): void {
    this.db
      .update(workflowRuns)
      .set({ status, pendingApprovalId: null, errorCode: error?.code ?? null, errorMessage: error?.message ?? null, updatedAt: new Date().toISOString() })
      .where(eq(workflowRuns.id, workflowRunId))
      .run();
    const run = this.db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).get();
    this.audit.record({ userId: run?.userId, actorType: "system", action: `workflow.${status}`, targetType: "workflow", targetId: run?.workflowId, runId: run?.agentRunId, details: { workflowRunId, error: error?.code } });
  }
}

/** Resolves `{{inputs.x}}` / `{{steps.id.path.-1.field}}` references (negative index = from end). */
export function resolveTemplates(input: Record<string, Template>, state: WorkflowState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    out[key] = whole ? lookup(state, whole[1]!) : value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => String(lookup(state, path) ?? ""));
  }
  return out;
}

function lookup(state: WorkflowState, path: string): unknown {
  let current: unknown = state;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^-?\d+$/.test(part)) {
      const i = Number(part);
      current = current[i < 0 ? current.length + i : i];
    } else current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""));
}
