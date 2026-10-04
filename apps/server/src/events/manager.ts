import { classifyImportance, type Importance, type ModelProvider } from "@lou/agent";
import type { NotificationAction } from "@lou/protocol";
import { newId } from "@lou/shared";
import { desc, eq } from "drizzle-orm";
import type { AuditLog } from "../core/audit";
import type { NotificationRule, SettingsStore } from "../core/settings";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import type { Logger } from "../logger";
import type { MemoryStore } from "../memory/store";
import type { NotificationManager } from "../notifications/manager";

/** Normalized external/system event (ARCHITECTURE.md §3.8). */
export interface AgentEventInput {
  userId: string;
  source: string;
  accountId?: string;
  type: string;
  /** Provider-unique ID used for de-duplication. */
  externalId: string;
  trust: "trusted-system" | "external-untrusted";
  occurredAt: string;
  payload: Record<string, unknown>;
}

export type EventDecision = "ignore" | "log" | "notify" | "propose";

interface Normalized {
  title: string;
  from: string;
  subject: string;
  content: string;
  replyCommand?: string;
}

const NOTIFY_THRESHOLD = 0.7;
const PROPOSE_THRESHOLD = 0.6;

/**
 * Event pipeline: event → deterministic filters → optional Luna classification →
 * ignore / log / notify / propose action. Deterministic rules run first so
 * stable preferences never cost a model call.
 */
export class EventManager {
  constructor(
    private readonly db: Db,
    private readonly notifications: NotificationManager,
    private readonly memory: MemoryStore,
    private readonly settings: SettingsStore,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly classifier?: ModelProvider,
  ) {}

  async ingest(input: AgentEventInput): Promise<{ eventId: string; decision: EventDecision } | undefined> {
    const id = newId("evt");
    const inserted = this.db
      .insert(events)
      .values({
        id,
        userId: input.userId,
        source: input.source,
        accountId: input.accountId ?? null,
        type: input.type,
        externalId: input.externalId,
        trust: input.trust,
        payload: input.payload,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return undefined; // duplicate delivery

    try {
      const decision = await this.process(id, input);
      return { eventId: id, decision };
    } catch (err) {
      this.logger.error({ err, eventId: id }, "event processing failed");
      this.db.update(events).set({ status: "failed", processedAt: new Date().toISOString() }).where(eq(events.id, id)).run();
      return { eventId: id, decision: "log" };
    }
  }

  recent(userId: string, limit = 50) {
    return this.db.select().from(events).where(eq(events.userId, userId)).orderBy(desc(events.createdAt)).limit(limit).all();
  }

  private async process(eventId: string, input: AgentEventInput): Promise<EventDecision> {
    const n = normalize(input);
    let decision: EventDecision | undefined = this.applyRules(input, n, this.settings.notificationRules());
    let classification: Importance | undefined;
    let reason = decision ? "rule" : undefined;

    if (!decision) {
      const builtin = builtinFilter(input);
      if (builtin) {
        decision = builtin;
        reason = "builtin_filter";
      }
    }

    if (!decision && this.classifier && input.trust === "external-untrusted") {
      const rules = (await this.memory.search(input.userId, `${n.from} ${n.subject}`, 6, ["notification_rule", "contact", "preference"])).map((m) => m.content);
      classification = await classifyImportance(this.classifier, { source: input.source, title: `${n.from} — ${n.subject}`, content: n.content, rules }).catch((err) => {
        // Model unavailable (not configured, not signed in, offline): keep the event, don't guess.
        this.logger.warn({ err: (err as Error).message, eventId }, "importance classification unavailable");
        return undefined;
      });
      decision = !classification
        ? "log"
        : classification.needsResponse && classification.importance >= PROPOSE_THRESHOLD
          ? "propose"
          : classification.importance >= NOTIFY_THRESHOLD
            ? "notify"
            : classification.importance >= 0.3
              ? "log"
              : "ignore";
      reason = classification?.reasonCode ?? "classifier_unavailable";
    }
    decision ??= "log";

    if (decision === "notify" || decision === "propose") {
      const actions: NotificationAction[] = [];
      if (decision === "propose" && n.replyCommand) actions.push({ id: "reply", label: "Reply", kind: "reply", value: n.replyCommand });
      actions.push({ id: "dismiss", label: "Dismiss", kind: "dismiss" });
      this.notifications.create({
        userId: input.userId,
        eventId,
        source: input.source,
        title: n.title,
        body: classification?.summary ?? n.subject,
        category: classification?.category,
        importance: classification?.importance ?? 0.8,
        actions,
      });
    }

    this.db
      .update(events)
      .set({ status: "processed", decision, classification: classification ?? (reason ? { reasonCode: reason } : null), processedAt: new Date().toISOString() })
      .where(eq(events.id, eventId))
      .run();
    this.audit.record({ userId: input.userId, actorType: "system", action: "event.processed", targetType: "event", targetId: eventId, details: { source: input.source, type: input.type, decision, reason } });
    return decision;
  }

  private applyRules(input: AgentEventInput, n: Normalized, rules: NotificationRule[]): EventDecision | undefined {
    for (const rule of rules) {
      if (rule.source && rule.source !== input.source) continue;
      if (rule.fromContains && !n.from.toLowerCase().includes(rule.fromContains.toLowerCase())) continue;
      if (rule.subjectContains && !n.subject.toLowerCase().includes(rule.subjectContains.toLowerCase())) continue;
      return rule.action;
    }
    return undefined;
  }
}

function builtinFilter(input: AgentEventInput): EventDecision | undefined {
  const p = input.payload;
  if (input.source === "gmail") {
    const labels = (p.labelIds as string[] | undefined) ?? [];
    if (labels.some((l) => ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM"].includes(l))) return "ignore";
    if (p.bulk) return "log";
    if (/no-?reply|do-?not-?reply|notifications?@|mailer-daemon/i.test(String(p.from ?? ""))) return "log";
  }
  if (input.source === "instagram" && (p.isReaction || p.isEcho)) return "ignore";
  return undefined;
}

function normalize(input: AgentEventInput): Normalized {
  const p = input.payload;
  if (input.source === "gmail") {
    const from = String(p.from ?? "");
    const name = from.replace(/<.*>/, "").replace(/"/g, "").trim() || from;
    const subject = String(p.subject ?? "(no subject)");
    return {
      title: name,
      from,
      subject,
      content: `From: ${from}\nSubject: ${subject}\n\n${String(p.snippet ?? "")}`,
      replyCommand: `Reply to the email from ${name} about "${subject.slice(0, 80)}"`,
    };
  }
  if (input.source === "instagram") {
    const from = String(p.senderUsername ?? p.senderId ?? "someone");
    return {
      title: `@${from}`,
      from,
      subject: "Instagram message",
      content: String(p.text ?? ""),
      replyCommand: `Reply to @${from}'s Instagram message`,
    };
  }
  return { title: input.type, from: input.source, subject: input.type, content: JSON.stringify(p).slice(0, 2000) };
}

