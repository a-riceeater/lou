import type { SettingsView, UpdateSettingsRequest } from "@lou/protocol";
import type { EmergencyControls } from "@lou/tools";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import type { AuditLog } from "./audit";

const DEFAULTS: SettingsView = {
  writeToolsDisabled: false,
  deviceControlDisabled: false,
  monitoringDisabled: false,
  agentPaused: false,
  autoActivateLowRiskSkills: false,
  aiProvider: "openai_api",
};

export const NotificationRuleSchema = z.object({
  id: z.string(),
  source: z.string().optional(),
  fromContains: z.string().optional(),
  subjectContains: z.string().optional(),
  action: z.enum(["notify", "ignore", "log"]),
});
export type NotificationRule = z.infer<typeof NotificationRuleSchema>;

/**
 * Persistent server settings, including the emergency controls. These are read
 * by the policy engine on every tool call, so changes take effect immediately.
 */
export class SettingsStore {
  private cache: SettingsView | undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    /** Defaults from configuration (e.g. AI_PROVIDER) for values never changed in the UI. */
    private readonly defaults: Partial<SettingsView> = {},
  ) {}

  get(): SettingsView {
    if (this.cache) return this.cache;
    const row = this.db.select().from(settings).where(eq(settings.key, "controls")).get();
    this.cache = { ...DEFAULTS, ...this.defaults, ...((row?.value as Partial<SettingsView>) ?? {}) };
    return this.cache;
  }

  controls(): EmergencyControls {
    const s = this.get();
    return { writeToolsDisabled: s.writeToolsDisabled, deviceControlDisabled: s.deviceControlDisabled, agentPaused: s.agentPaused };
  }

  update(patch: UpdateSettingsRequest, actor: { userId: string; deviceId?: string }): SettingsView {
    const previous = this.get();
    const next = { ...previous, ...patch };
    this.write("controls", next);
    this.cache = next;
    this.audit.record({
      userId: actor.userId,
      actorType: actor.deviceId ? "device" : "user",
      actorId: actor.deviceId ?? actor.userId,
      action: "settings.changed",
      targetType: "settings",
      details: patch,
    });
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  private readonly listeners = new Set<(next: SettingsView, previous: SettingsView) => void>();

  onChange(listener: (next: SettingsView, previous: SettingsView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notificationRules(): NotificationRule[] {
    const row = this.db.select().from(settings).where(eq(settings.key, "notification_rules")).get();
    const parsed = z.array(NotificationRuleSchema).safeParse(row?.value ?? []);
    return parsed.success ? parsed.data : [];
  }

  setNotificationRules(rules: NotificationRule[]): void {
    this.write("notification_rules", rules);
  }

  /** Integration-owned values (e.g. app credentials entered in the UI). Callers encrypt secrets first. */
  getValue<T>(key: string, schema: z.ZodType<T>): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    const parsed = schema.safeParse(row?.value);
    return parsed.success ? parsed.data : undefined;
  }

  setValue(key: string, value: unknown): void {
    this.write(key, value);
  }

  deleteValue(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  private write(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` } })
      .run();
  }
}
