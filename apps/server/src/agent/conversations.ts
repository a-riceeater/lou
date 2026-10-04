import { LouError, newId } from "@lou/shared";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { conversations, messages } from "../db/schema";

/** Conversation threads: user requests and final assistant answers only. */
export class ConversationStore {
  constructor(private readonly db: Db) {}

  getOrCreate(userId: string, conversationId?: string): string {
    if (conversationId) {
      const row = this.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!row || row.userId !== userId) throw new LouError("NOT_FOUND", "Conversation not found.");
      return row.id;
    }
    const id = newId("conv");
    this.db.insert(conversations).values({ id, userId }).run();
    return id;
  }

  add(conversationId: string, role: "user" | "assistant", content: string, runId?: string): void {
    this.db.insert(messages).values({ id: newId("msg"), conversationId, role, content, runId: runId ?? null }).run();
    this.db
      .update(conversations)
      .set({ updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  /** Most recent turns (oldest first), excluding a given run's own messages. */
  recent(conversationId: string, limit: number, excludeRunId?: string): Array<{ role: "user" | "assistant"; content: string }> {
    const where = excludeRunId
      ? and(eq(messages.conversationId, conversationId), ne(messages.runId, excludeRunId))
      : eq(messages.conversationId, conversationId);
    return this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all()
      .reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 2000) }));
  }
}
