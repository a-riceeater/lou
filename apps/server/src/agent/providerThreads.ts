import type { CodexThreadRecord, CodexThreadStore } from "@lou/agent";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { providerThreads } from "../db/schema";

/** Persists conversation → Codex thread mappings so threads survive server restarts. */
export class DbCodexThreadStore implements CodexThreadStore {
  constructor(private readonly db: Db) {}

  async get(conversationId: string): Promise<CodexThreadRecord | undefined> {
    const row = this.db
      .select()
      .from(providerThreads)
      .where(sql`${providerThreads.conversationId} = ${conversationId} and ${providerThreads.provider} = 'codex_cli'`)
      .get();
    return row ? { conversationId, threadId: row.threadId, toolset: row.toolset, notes: row.notes, wantedFamilies: row.wantedFamilies } : undefined;
  }

  async save(record: CodexThreadRecord): Promise<void> {
    const values = { threadId: record.threadId, toolset: record.toolset, notes: record.notes, wantedFamilies: record.wantedFamilies };
    this.db
      .insert(providerThreads)
      .values({ conversationId: record.conversationId, provider: "codex_cli", ...values })
      .onConflictDoUpdate({
        target: [providerThreads.conversationId, providerThreads.provider],
        set: { ...values, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` },
      })
      .run();
  }
}
