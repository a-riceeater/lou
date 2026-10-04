import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillDetail, SkillSummary, SkillVersionStatus, SkillVersionView } from "@lou/protocol";
import { Bm25Index, LouError, newId, type RiskLevel } from "@lou/shared";
import { hasErrors, loadSkillDirectory, parseSkillMd, serializeSkillMd, validateSkill, type ParsedSkill } from "@lou/skills";
import type { ToolRegistry } from "@lou/tools";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AuditLog } from "../core/audit";
import type { Db } from "../db/client";
import { skills, skillVersions } from "../db/schema";
import type { Logger } from "../logger";

type SkillRow = typeof skills.$inferSelect;
type VersionRow = typeof skillVersions.$inferSelect;

export interface ProposeResult {
  skillId: string;
  versionId: string;
  version: number;
  status: SkillVersionStatus;
  issues: string[];
  risk: RiskLevel;
}

/**
 * Skills = persistent procedural knowledge (portable SKILL.md). Every change is a
 * new version with a lifecycle (proposed → active → deprecated / rolled_back).
 * Skills never carry authority: the validator rejects anything that tries to
 * bypass approvals or escalate, and tool permissions stay in the ToolRegistry.
 */
export class SkillRegistry {
  private index: Bm25Index | undefined;

  constructor(
    private readonly db: Db,
    private readonly tools: ToolRegistry,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly exportDir?: string,
  ) {}

  /** Loads built-in skills from disk, versioning any content changes. */
  async syncBuiltins(dir: string): Promise<{ loaded: number; errors: number }> {
    const { skills: files, errors } = await loadSkillDirectory(dir);
    for (const e of errors) this.logger.warn({ path: e.path, error: e.message }, "invalid built-in skill");
    for (const file of files) {
      const id = file.skill.frontmatter.name;
      const existing = this.db.select().from(skills).where(eq(skills.id, id)).get();
      if (!existing) {
        this.db.insert(skills).values({ id, name: id, description: file.skill.frontmatter.description, category: file.category, origin: "builtin", risk: file.skill.frontmatter.risk, tools: file.skill.frontmatter.tools }).run();
      }
      const latestBuiltin = this.db
        .select()
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, id), eq(skillVersions.createdBy, "builtin")))
        .orderBy(desc(skillVersions.version))
        .get();
      if (latestBuiltin && latestBuiltin.content.trim() === file.skill.source.trim()) continue;

      const result = this.insertVersion(id, file.skill, { createdBy: "builtin", reason: latestBuiltin ? "Built-in skill updated" : "Built-in skill" });
      const active = this.activeVersion(id);
      // Built-in updates replace built-in versions, but never silently replace a learned/user patch.
      if (result.status === "proposed" && (!active || active.createdBy === "builtin")) this.activate(result.versionId, { type: "system" });
    }
    this.index = undefined;
    return { loaded: files.length, errors: errors.length };
  }

  propose(input: { content: string; createdBy: "agent" | "user"; sourceRunId?: string; reason?: string }): ProposeResult {
    const parsed = parseSkillMd(input.content);
    const id = parsed.frontmatter.name;
    if (!this.db.select().from(skills).where(eq(skills.id, id)).get()) {
      this.db.insert(skills).values({ id, name: id, description: parsed.frontmatter.description, origin: input.createdBy, risk: parsed.frontmatter.risk, tools: parsed.frontmatter.tools }).run();
    }
    const result = this.insertVersion(id, parsed, input);
    this.audit.record({
      actorType: input.createdBy === "agent" ? "agent" : "user",
      action: "skill.proposed",
      targetType: "skill",
      targetId: id,
      runId: input.sourceRunId,
      details: { version: result.version, status: result.status, issues: result.issues, reason: input.reason },
    });
    return result;
  }

  activate(versionId: string, actor: { type: "user" | "device" | "system"; id?: string; userId?: string }): void {
    const version = this.db.select().from(skillVersions).where(eq(skillVersions.id, versionId)).get();
    if (!version) throw new LouError("NOT_FOUND", "Skill version not found.");
    if (version.status === "rejected") throw new LouError("VALIDATION_FAILED", "Rejected versions cannot be activated.");
    if (version.status === "active") return;
    // Re-validate at activation time: tools or policy may have changed since proposal.
    const parsed = parseSkillMd(version.content);
    const issues = validateSkill(parsed, { toolRisk: (t) => this.tools.get(t)?.risk });
    if (hasErrors(issues)) throw new LouError("VALIDATION_FAILED", issues.map((i) => i.message).join("; "));

    this.db.transaction((tx) => {
      tx.update(skillVersions).set({ status: "deprecated" }).where(and(eq(skillVersions.skillId, version.skillId), eq(skillVersions.status, "active"))).run();
      tx.update(skillVersions).set({ status: "active" }).where(eq(skillVersions.id, versionId)).run();
      tx.update(skills)
        .set({ activeVersion: version.version, description: parsed.frontmatter.description, risk: parsed.frontmatter.risk, tools: parsed.frontmatter.tools, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
        .where(eq(skills.id, version.skillId))
        .run();
    });
    this.index = undefined;
    this.audit.record({ userId: actor.userId, actorType: actor.type, actorId: actor.id, action: "skill.activated", targetType: "skill", targetId: version.skillId, runId: version.sourceRunId, details: { version: version.version } });
    if (version.createdBy !== "builtin") void this.export(version.skillId, version.content);
  }

  reject(versionId: string, actor: { type: "user" | "device"; id?: string; userId?: string }): void {
    const version = this.db.select().from(skillVersions).where(eq(skillVersions.id, versionId)).get();
    if (!version || version.status === "active") throw new LouError("CONFLICT", "Only inactive versions can be rejected.");
    this.db.update(skillVersions).set({ status: "rejected" }).where(eq(skillVersions.id, versionId)).run();
    this.audit.record({ userId: actor.userId, actorType: actor.type, actorId: actor.id, action: "skill.rejected", targetType: "skill", targetId: version.skillId, details: { version: version.version } });
  }

  rollback(skillId: string, targetVersion: number, actor: { type: "user" | "device"; id?: string; userId?: string }): void {
    const target = this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, targetVersion))).get();
    if (!target) throw new LouError("NOT_FOUND", "That version does not exist.");
    const current = this.activeVersion(skillId);
    if (current?.id === target.id) return;
    this.activate(target.id, { type: actor.type, id: actor.id, userId: actor.userId });
    if (current) this.db.update(skillVersions).set({ status: "rolled_back" }).where(eq(skillVersions.id, current.id)).run();
    this.audit.record({ userId: actor.userId, actorType: actor.type, actorId: actor.id, action: "skill.rolled_back", targetType: "skill", targetId: skillId, details: { from: current?.version, to: targetVersion } });
  }

  setEnabled(skillId: string, enabled: boolean, actor: { type: "user" | "device"; id?: string; userId?: string }): void {
    const result = this.db.update(skills).set({ enabled }).where(eq(skills.id, skillId)).run();
    if (result.changes === 0) throw new LouError("NOT_FOUND", "Skill not found.");
    this.index = undefined;
    this.audit.record({ userId: actor.userId, actorType: actor.type, actorId: actor.id, action: enabled ? "skill.enabled" : "skill.disabled", targetType: "skill", targetId: skillId });
  }

  list(): SkillSummary[] {
    return this.db.select().from(skills).orderBy(skills.id).all().map((s) => this.summary(s));
  }

  detail(skillId: string): SkillDetail | undefined {
    const row = this.db.select().from(skills).where(eq(skills.id, skillId)).get();
    if (!row) return undefined;
    const versions = this.db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version)).all();
    const shown = versions.find((v) => v.status === "active") ?? versions[0];
    return { ...this.summary(row), content: shown?.content ?? "", versions: versions.map(versionView) };
  }

  /** Compact index entries for the model (progressive disclosure: no bodies). */
  search(query: string, limit = 4): Array<{ id: string; description: string }> {
    const rows = this.enabledRows();
    if (!this.index) this.index = new Bm25Index(rows.map((s) => ({ id: s.id, text: `${s.id.replace(/-/g, " ")} ${s.category} ${s.description}` })));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return this.index
      .search(query, limit)
      .filter((h) => h.score > 0.5)
      .map((h) => byId.get(h.id))
      .filter((r): r is SkillRow => !!r)
      .map((r) => ({ id: r.id, description: r.description }));
  }

  /** Full active skill for the `skills.read` tool. */
  read(skillId: string): { id: string; version: number; content: string; tools: string[]; risk: string } {
    const row = this.db.select().from(skills).where(eq(skills.id, skillId)).get();
    if (!row || !row.enabled || row.activeVersion === null) throw new LouError("NOT_FOUND", `No active skill "${skillId}".`);
    const version = this.activeVersion(skillId)!;
    const parsed = parseSkillMd(version.content);
    return { id: row.id, version: version.version, content: parsed.body, tools: row.tools, risk: row.risk };
  }

  recordOutcome(skillIds: string[], success: boolean): void {
    for (const id of skillIds) {
      const active = this.activeVersion(id);
      if (!active) continue;
      this.db
        .update(skillVersions)
        .set(success ? { successCount: active.successCount + 1 } : { failureCount: active.failureCount + 1 })
        .where(eq(skillVersions.id, active.id))
        .run();
    }
  }

  activeVersion(skillId: string): VersionRow | undefined {
    return this.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.status, "active"))).get();
  }

  // -------------------------------------------------------------------------

  private insertVersion(skillId: string, parsed: ParsedSkill, meta: { createdBy: string; sourceRunId?: string; reason?: string }): ProposeResult {
    const max = this.db
      .select({ v: sql<number>`coalesce(max(${skillVersions.version}), 0)` })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .get();
    const version = Math.max((max?.v ?? 0) + 1, meta.createdBy === "builtin" ? parsed.frontmatter.version : 0);
    // Keep the file's version consistent with the stored version number.
    const content = parsed.frontmatter.version === version ? parsed.source : serializeSkillMd({ ...parsed.frontmatter, version }, parsed.body);
    const issues = validateSkill(parsed, { toolRisk: (t) => this.tools.get(t)?.risk });
    const status: SkillVersionStatus = hasErrors(issues) ? "rejected" : "proposed";
    const versionId = newId("skv");
    this.db
      .insert(skillVersions)
      .values({
        id: versionId,
        skillId,
        version,
        content,
        status,
        createdBy: meta.createdBy,
        sourceRunId: meta.sourceRunId ?? null,
        reason: meta.reason ?? null,
        issues: issues.map((i) => `${i.severity}: ${i.message}`),
      })
      .run();
    if (status === "rejected") this.logger.warn({ skillId, version, issues }, "skill version rejected by validator");
    return { skillId, versionId, version, status, issues: issues.map((i) => i.message), risk: parsed.frontmatter.risk };
  }

  private enabledRows(): SkillRow[] {
    return this.db.select().from(skills).all().filter((s) => s.enabled && s.activeVersion !== null);
  }

  private summary(s: SkillRow): SkillSummary {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.activeVersion ?? 0,
      risk: s.risk as RiskLevel,
      enabled: s.enabled,
      origin: s.origin as SkillSummary["origin"],
      tools: s.tools,
      updatedAt: s.updatedAt,
    };
  }

  private async export(skillId: string, content: string): Promise<void> {
    if (!this.exportDir) return;
    try {
      const dir = join(this.exportDir, skillId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), content, "utf8");
    } catch (err) {
      this.logger.warn({ err, skillId }, "failed to export skill");
    }
  }
}

function versionView(v: VersionRow): SkillVersionView {
  return {
    id: v.id,
    version: v.version,
    status: v.status as SkillVersionStatus,
    createdBy: v.createdBy,
    reason: v.reason,
    sourceRunId: v.sourceRunId,
    issues: v.issues,
    createdAt: v.createdAt,
  };
}
