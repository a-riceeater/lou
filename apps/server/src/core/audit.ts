import type { AuditEntry } from "@lou/protocol";
import { newId } from "@lou/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLog } from "../db/schema";

export type ActorType = "user" | "device" | "agent" | "system";

export interface AuditRecord {
  userId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  runId?: string | null;
  details?: Record<string, unknown>;
}

const SECRET_KEY = /(token|secret|password|authorization|cookie|credential|api[_-]?key|code_verifier|commandkey)/i;

/** Removes anything that looks like a secret before it is persisted. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrubSecrets(v, depth + 1);
  }
  return out;
}

/** Append-only audit trail of security-relevant actions (SECURITY.md §11). */
export class AuditLog {
  constructor(private readonly db: Db) {}

  record(entry: AuditRecord): void {
    this.db
      .insert(auditLog)
      .values({
        id: newId("aud"),
        userId: entry.userId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        runId: entry.runId ?? null,
        details: (scrubSecrets(entry.details ?? {}) as Record<string, unknown>) ?? {},
      })
      .run();
  }

  list(options: { userId?: string; runId?: string; before?: string; limit?: number }): AuditEntry[] {
    const conditions = [];
    if (options.runId) conditions.push(eq(auditLog.runId, options.runId));
    if (options.before) conditions.push(lt(auditLog.createdAt, options.before));
    const rows = this.db
      .select()
      .from(auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(Math.min(options.limit ?? 100, 500))
      .all();
    return rows
      .filter((r) => !options.userId || r.userId === null || r.userId === options.userId)
      .map((r) => ({
        id: r.id,
        actorType: r.actorType as AuditEntry["actorType"],
        actorId: r.actorId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        runId: r.runId,
        details: r.details,
        createdAt: r.createdAt,
      }));
  }
}
