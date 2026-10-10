import type { ProviderId, ProviderThreadRecord, ProviderThreadStore } from "@lou/agent";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { providerThreads } from "../db/schema";

/** Persists conversation → provider thread (Codex thread, Claude Code session) mappings so they survive server restarts. */
export class DbProviderThreadStore implements ProviderThreadStore {
  constructor(
    private readonly db: Db,
    private readonly provider: Exclude<ProviderId, "openai_api">,
  ) {}

  async get(conversationId: string): Promise<ProviderThreadRecord | undefined> {
    const row = this.db
      .select()
      .from(providerThreads)
      .where(and(eq(providerThreads.conversationId, conversationId), eq(providerThreads.provider, this.provider)))
      .get();
    return row ? { conversationId, threadId: row.threadId, toolset: row.toolset, notes: row.notes, wantedFamilies: row.wantedFamilies } : undefined;
  }

  async save(record: ProviderThreadRecord): Promise<void> {
    const values = { threadId: record.threadId, toolset: record.toolset, notes: record.notes, wantedFamilies: record.wantedFamilies };
    this.db
      .insert(providerThreads)
      .values({ conversationId: record.conversationId, provider: this.provider, ...values })
      .onConflictDoUpdate({
        target: [providerThreads.conversationId, providerThreads.provider],
        set: { ...values, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` },
      })
      .run();
  }
}
