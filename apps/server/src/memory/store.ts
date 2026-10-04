import { cosineSimilarity, type EmbeddingProvider } from "@lou/agent";
import type { MemoryType, MemoryView } from "@lou/protocol";
import { Bm25Index, LouError, newId } from "@lou/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AuditLog } from "../core/audit";
import type { Db } from "../db/client";
import { memories } from "../db/schema";
import type { Logger } from "../logger";

type Row = typeof memories.$inferSelect;

/** Content that looks like a credential is refused; secrets belong in the vault. */
const SECRET_PATTERNS = [
  /\b(password|passcode|passwd|pin)\b\s*(is|:|=)/i,
  /\b(api[ _-]?key|secret|token|bearer)\b\s*(is|:|=)/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\b\d{13,19}\b/, // card-number-like digit runs
];

export interface MemoryInput {
  userId: string;
  type: MemoryType;
  content: string;
  source: "user" | "agent-inferred";
  confidence?: number;
  status?: "active" | "proposed";
  sourceRunId?: string;
  expiresAt?: string;
}

/**
 * Persistent facts and preferences (separate from skills). Retrieval blends
 * embedding similarity (when configured) with BM25 so it works offline too.
 * User-stated memories outrank agent-inferred ones.
 */
export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly embeddings?: EmbeddingProvider,
  ) {}

  async create(input: MemoryInput, actor: { type: "user" | "device" | "agent"; id?: string }): Promise<MemoryView> {
    const content = input.content.trim();
    if (SECRET_PATTERNS.some((p) => p.test(content))) {
      throw new LouError("VALIDATION_FAILED", "That looks like a password or credential. Secrets are never stored in memory.");
    }
    const id = newId("mem");
    const confidence = input.confidence ?? (input.source === "user" ? 1 : 0.6);
    this.db
      .insert(memories)
      .values({
        id,
        userId: input.userId,
        type: input.type,
        content,
        source: input.source,
        // Agent-inferred memories are capped below explicit user statements.
        confidence: input.source === "agent-inferred" ? Math.min(confidence, 0.8) : confidence,
        status: input.status ?? "active",
        sourceRunId: input.sourceRunId ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .run();
    void this.embed(id, content);
    this.audit.record({ userId: input.userId, actorType: actor.type, actorId: actor.id, action: "memory.created", targetType: "memory", targetId: id, runId: input.sourceRunId, details: { type: input.type, source: input.source, status: input.status ?? "active" } });
    return toView(this.row(input.userId, id)!);
  }

  list(userId: string, status?: "active" | "proposed"): MemoryView[] {
    const where = status ? and(eq(memories.userId, userId), eq(memories.status, status)) : and(eq(memories.userId, userId), inArray(memories.status, ["active", "proposed"]));
    return this.db.select().from(memories).where(where).orderBy(desc(memories.updatedAt)).all().filter(notExpired).map(toView);
  }

  async update(userId: string, id: string, patch: { content?: string; type?: MemoryType; status?: "active" }, actor: { type: "user" | "device"; id?: string }): Promise<MemoryView> {
    const row = this.row(userId, id);
    if (!row) throw new LouError("NOT_FOUND", "Memory not found.");
    if (patch.content && SECRET_PATTERNS.some((p) => p.test(patch.content!))) {
      throw new LouError("VALIDATION_FAILED", "That looks like a password or credential. Secrets are never stored in memory.");
    }
    this.db
      .update(memories)
      .set({
        ...(patch.content ? { content: patch.content, embedding: null, embeddingModel: null } : {}),
        ...(patch.type ? { type: patch.type } : {}),
        // Editing or accepting a memory makes it a user statement.
        ...(patch.status || patch.content ? { status: "active", source: "user", confidence: 1 } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(memories.id, id))
      .run();
    if (patch.content) void this.embed(id, patch.content);
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "memory.updated", targetType: "memory", targetId: id, details: { fields: Object.keys(patch) } });
    return toView(this.row(userId, id)!);
  }

  delete(userId: string, id: string, actor: { type: "user" | "device"; id?: string }): void {
    const result = this.db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, userId))).run();
    if (result.changes === 0) throw new LouError("NOT_FOUND", "Memory not found.");
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "memory.deleted", targetType: "memory", targetId: id });
  }

  /** Top memories for a query: blended semantic + lexical score, weighted by confidence. */
  async search(userId: string, query: string, limit = 5, types?: MemoryType[]): Promise<MemoryView[]> {
    let rows = this.db.select().from(memories).where(and(eq(memories.userId, userId), eq(memories.status, "active"))).all().filter(notExpired);
    if (types?.length) rows = rows.filter((r) => types.includes(r.type as MemoryType));
    if (!rows.length) return [];

    const lexical = new Map(new Bm25Index(rows.map((r) => ({ id: r.id, text: `${r.type} ${r.content}` }))).search(query, rows.length).map((h) => [h.id, h.score]));
    const maxLex = Math.max(1e-9, ...lexical.values());

    const semantic = new Map<string, number>();
    if (this.embeddings) {
      try {
        const [q] = await this.embeddings.embed([query]);
        if (q) {
          for (const r of rows) {
            if (r.embedding && r.embeddingModel === this.embeddings.model) {
              // Copy into an aligned buffer: SQLite blobs are not guaranteed 4-byte aligned.
              semantic.set(r.id, cosineSimilarity(q, new Float32Array(Uint8Array.from(r.embedding).buffer)));
            }
          }
        }
      } catch (err) {
        this.logger.warn({ err }, "memory embedding search failed; using lexical only");
      }
    }

    const scored = rows
      .map((r) => {
        const lex = (lexical.get(r.id) ?? 0) / maxLex;
        const sem = semantic.get(r.id);
        const base = sem === undefined ? lex : 0.65 * Math.max(0, (sem - 0.2) / 0.8) + 0.35 * lex;
        // Always keep a few broadly useful identity/preference memories in play.
        const prior = r.type === "identity" || r.type === "preference" ? 0.05 : 0;
        return { r, score: (base + prior) * (0.5 + 0.5 * r.confidence) };
      })
      .filter((s) => s.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s) => toView(s.r));
  }

  private row(userId: string, id: string): Row | undefined {
    return this.db.select().from(memories).where(and(eq(memories.id, id), eq(memories.userId, userId))).get();
  }

  private async embed(id: string, content: string): Promise<void> {
    if (!this.embeddings) return;
    try {
      const [vec] = await this.embeddings.embed([content]);
      if (!vec) return;
      this.db.update(memories).set({ embedding: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), embeddingModel: this.embeddings.model }).where(eq(memories.id, id)).run();
    } catch (err) {
      this.logger.warn({ err, memoryId: id }, "failed to embed memory");
    }
  }
}

function notExpired(r: Row): boolean {
  return !r.expiresAt || r.expiresAt > new Date().toISOString();
}

function toView(r: Row): MemoryView {
  return {
    id: r.id,
    type: r.type as MemoryType,
    content: r.content,
    source: r.source as MemoryView["source"],
    confidence: r.confidence,
    status: r.status as MemoryView["status"],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
  };
}
