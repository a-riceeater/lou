import { LouError } from "@lou/shared";
import type { EventManager } from "../../events/manager";
import type { Logger } from "../../logger";
import type { IntegrationManager } from "../manager";
import type { GmailClient } from "./gmail";

/**
 * Polls Gmail history for new inbox messages and feeds them to the event
 * pipeline. Polling needs no public endpoint or Pub/Sub setup; push via
 * `users.watch` can replace it later without changing the event pipeline.
 */
export class GmailPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly integrations: IntegrationManager,
    private readonly client: (accountId: string) => GmailClient,
    private readonly events: EventManager,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly enabled: () => boolean,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      for (const account of this.integrations.allConnected("google")) {
        try {
          await this.pollAccount(account.id, account.userId, account.metadata.historyId as string | undefined);
        } catch (err) {
          const e = err instanceof LouError ? err : new LouError("UPSTREAM_ERROR", String(err));
          this.logger.warn({ accountId: account.id, code: e.code, err: e.message }, "gmail poll failed");
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollAccount(accountId: string, userId: string, historyId: string | undefined): Promise<void> {
    const gmail = this.client(accountId);
    if (!historyId) {
      const profile = await gmail.profile();
      this.integrations.updateMetadata(accountId, { historyId: profile.historyId });
      return;
    }
    let result;
    try {
      result = await gmail.newMessagesSince(historyId);
    } catch (err) {
      if (err instanceof LouError && err.code === "NOT_FOUND") {
        // History ID expired (≈ a week). Reset without backfilling.
        const profile = await gmail.profile();
        this.integrations.updateMetadata(accountId, { historyId: profile.historyId });
        return;
      }
      throw err;
    }
    for (const messageId of result.messageIds.slice(0, 25)) {
      const meta = await gmail.messageMeta(messageId);
      await this.events.ingest({
        userId,
        source: "gmail",
        accountId,
        type: "email.received",
        externalId: `gmail:${accountId}:${messageId}`,
        trust: "external-untrusted",
        occurredAt: Number.isFinite(Date.parse(meta.date)) ? new Date(Date.parse(meta.date)).toISOString() : new Date().toISOString(),
        payload: {
          messageId: meta.id,
          threadId: meta.threadId,
          from: meta.from,
          subject: meta.subject,
          snippet: meta.snippet,
          labelIds: meta.labelIds,
          bulk: meta.bulk,
        },
      });
    }
    this.integrations.updateMetadata(accountId, { historyId: result.historyId });
  }
}
