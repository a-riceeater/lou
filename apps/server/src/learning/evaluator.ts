import { evaluateImprovement, type ModelProvider, type RunState } from "@lou/agent";
import { Bm25Index, maxRisk, newId, type RiskLevel } from "@lou/shared";
import { serializeSkillMd } from "@lou/skills";
import type { ToolRegistry } from "@lou/tools";
import { and, desc, eq } from "drizzle-orm";
import type { AuditLog } from "../core/audit";
import type { SettingsStore } from "../core/settings";
import type { Db } from "../db/client";
import { approvals, proposals, toolCalls } from "../db/schema";
import type { Logger } from "../logger";
import type { MemoryStore } from "../memory/store";
import type { SkillRegistry } from "../skills/registry";
import type { DbRunStore } from "../agent/runStore";
import type { ProposalView } from "@lou/protocol";
import { LouError } from "@lou/shared";

const MIN_INTERVAL_MS = 30_000;

/**
 * Self-improvement foundation (AGENT_SYSTEM.md §4, §11). After selected
 * successful runs, Luna reviews a compact, reasoning-free summary and proposes
 * NO_CHANGE / MEMORY / SKILL / SKILL_PATCH / WORKFLOW. Risk of any proposed skill
 * is computed by the server from the registry — never taken from the model —
 * and only read-only skills may auto-activate (and only when enabled).
 */
export class ImprovementEvaluator {
  private lastRun = 0;

  constructor(
    private readonly db: Db,
    private readonly model: ModelProvider,
    private readonly tools: ToolRegistry,
    private readonly skills: SkillRegistry,
    private readonly memory: MemoryStore,
    private readonly runs: DbRunStore,
    private readonly settings: SettingsStore,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
  ) {}

  /** Selection: user runs that completed with tool use; throttled. */
  shouldEvaluate(state: RunState): boolean {
    if (state.status !== "completed" || state.source !== "user") return false;
    if (!state.transcript.some((m) => m.role === "tool")) return false;
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false;
    return true;
  }

  async evaluate(state: RunState): Promise<void> {
    this.lastRun = Date.now();
    const calls = this.db.select().from(toolCalls).where(eq(toolCalls.runId, state.runId)).all();
    const runApprovals = this.db.select().from(approvals).where(eq(approvals.runId, state.runId)).all();
    const recent = this.runs.recentRequests(state.userId, 40).filter((r) => r.id !== state.runId);
    const similar = new Bm25Index(recent.map((r) => ({ id: r.id, text: r.request })))
      .search(state.request, 5)
      .filter((h) => h.score > 1.5)
      .map((h) => recent.find((r) => r.id === h.id)!.request);

    const loaded = state.loadedSkills.map((id) => {
      try {
        return { id, content: this.skills.read(id).content };
      } catch {
        return { id, content: "" };
      }
    });
    const improvement = await evaluateImprovement(this.model, {
      request: state.request,
      toolSequence: calls.map((c) => ({ toolId: c.toolId, status: c.status })),
      approvals: runApprovals.map((a) => ({ edited: a.edited, decision: a.status })),
      loadedSkills: loaded,
      finalMessage: state.finalMessage ?? "",
      similarRecentRequests: similar,
      existingSkills: this.skills.list().map((s) => ({ id: s.id, description: s.description })),
      availableTools: this.tools.list().filter((t) => t.exposure === "model").map((t) => t.id),
    });

    this.audit.record({ userId: state.userId, actorType: "agent", action: "improvement.evaluated", runId: state.runId, details: { decision: improvement.decision, reason: improvement.reason } });

    switch (improvement.decision) {
      case "NO_CHANGE":
        return;
      case "MEMORY_PROPOSAL": {
        if (!improvement.memory) return;
        // Low-risk preferences may be saved automatically (as inferred, lower trust); others wait for review.
        const auto = improvement.memory.type === "preference";
        const m = await this.memory
          .create({ userId: state.userId, type: improvement.memory.type, content: improvement.memory.content, source: "agent-inferred", confidence: 0.6, status: auto ? "active" : "proposed", sourceRunId: state.runId }, { type: "agent" })
          .catch((err) => {
            this.logger.info({ err: (err as Error).message }, "memory proposal refused");
            return undefined;
          });
        if (m) this.record(state, "MEMORY_PROPOSAL", "Remember", improvement.memory.content, { memoryId: m.id }, m.id, auto ? "auto_applied" : "pending");
        return;
      }
      case "SKILL_PROPOSAL":
      case "SKILL_PATCH": {
        if (!improvement.skill) return;
        const tools = improvement.skill.tools.filter((t) => this.tools.get(t)?.exposure === "model");
        const risk: RiskLevel = maxRisk(tools.map((t) => this.tools.get(t)!.risk));
        const id = improvement.skill.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
        if (!id) return;
        const content = serializeSkillMd({ name: id, description: improvement.skill.description, version: 1, risk, tools }, improvement.skill.procedure);
        try {
          const result = this.skills.propose({ content, createdBy: "agent", sourceRunId: state.runId, reason: improvement.reason });
          let status: ProposalView["status"] = result.status === "rejected" ? "rejected" : "pending";
          if (result.status === "proposed" && risk === "read" && this.settings.get().autoActivateLowRiskSkills) {
            this.skills.activate(result.versionId, { type: "system" });
            status = "auto_applied";
          }
          this.record(state, improvement.decision, improvement.decision === "SKILL_PATCH" ? `Update skill ${id}` : `New skill ${id}`, improvement.skill.description, { skillId: id, versionId: result.versionId, version: result.version, issues: result.issues }, result.versionId, status);
        } catch (err) {
          this.logger.info({ err: (err as Error).message }, "skill proposal invalid");
        }
        return;
      }
      case "WORKFLOW_PROPOSAL":
        this.record(state, "WORKFLOW_PROPOSAL", "Workflow idea", improvement.reason, { skill: improvement.skill }, null, "pending");
        return;
    }
  }

  list(userId: string, status?: string): ProposalView[] {
    const where = status ? and(eq(proposals.userId, userId), eq(proposals.status, status)) : eq(proposals.userId, userId);
    return this.db
      .select()
      .from(proposals)
      .where(where)
      .orderBy(desc(proposals.createdAt))
      .limit(100)
      .all()
      .map((p) => ({ id: p.id, runId: p.runId, kind: p.kind as ProposalView["kind"], title: p.title, summary: p.summary, status: p.status as ProposalView["status"], createdAt: p.createdAt }));
  }

  /** User accepts or rejects a pending proposal; acceptance activates it. */
  async resolve(userId: string, id: string, accept: boolean, actor: { deviceId?: string }): Promise<void> {
    const p = this.db.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.userId, userId))).get();
    if (!p) throw new LouError("NOT_FOUND", "Proposal not found.");
    if (p.status !== "pending") throw new LouError("CONFLICT", "Proposal already resolved.");
    if (accept) {
      if ((p.kind === "SKILL_PROPOSAL" || p.kind === "SKILL_PATCH") && p.targetId) this.skills.activate(p.targetId, { type: "device", id: actor.deviceId, userId });
      if (p.kind === "MEMORY_PROPOSAL" && p.targetId) await this.memory.update(userId, p.targetId, { status: "active" }, { type: "device", id: actor.deviceId });
    } else {
      if ((p.kind === "SKILL_PROPOSAL" || p.kind === "SKILL_PATCH") && p.targetId) this.skills.reject(p.targetId, { type: "device", id: actor.deviceId, userId });
      if (p.kind === "MEMORY_PROPOSAL" && p.targetId) this.memory.delete(userId, p.targetId, { type: "device", id: actor.deviceId });
    }
    this.db.update(proposals).set({ status: accept ? "accepted" : "rejected", resolvedAt: new Date().toISOString() }).where(eq(proposals.id, id)).run();
    this.audit.record({ userId, actorType: "device", actorId: actor.deviceId, action: accept ? "proposal.accepted" : "proposal.rejected", targetType: "proposal", targetId: id, details: { kind: p.kind } });
  }

  private record(state: RunState, kind: string, title: string, summary: string, payload: Record<string, unknown>, targetId: string | null, status: string): void {
    this.db.insert(proposals).values({ id: newId("prp"), userId: state.userId, runId: state.runId, kind, title, summary: summary.slice(0, 500), payload, targetId, status }).run();
  }
}
