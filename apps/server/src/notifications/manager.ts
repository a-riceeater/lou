import type { NotificationAction, NotificationView } from "@lou/protocol";
import { LouError, newId } from "@lou/shared";
import { and, desc, eq, ne } from "drizzle-orm";
import type { EventBus } from "../core/bus";
import type { Db } from "../db/client";
import { notifications } from "../db/schema";

type Row = typeof notifications.$inferSelect;

/** The unified attention feed and push fan-out to devices. */
export class NotificationManager {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  create(input: {
    userId: string;
    eventId?: string;
    source: string;
    title: string;
    body: string;
    category?: string;
    importance: number;
    actions?: NotificationAction[];
  }): NotificationView {
    const id = newId("ntf");
    this.db
      .insert(notifications)
      .values({
        id,
        userId: input.userId,
        eventId: input.eventId ?? null,
        source: input.source,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 1000),
        category: input.category ?? null,
        importance: input.importance,
        actions: input.actions ?? [],
      })
      .run();
    const view = toView(this.db.select().from(notifications).where(eq(notifications.id, id)).get()!);
    this.bus.emit("notification.created", { userId: input.userId, notification: view });
    return view;
  }

  list(userId: string, options: { includeDismissed?: boolean; limit?: number } = {}): NotificationView[] {
    const where = options.includeDismissed ? eq(notifications.userId, userId) : and(eq(notifications.userId, userId), ne(notifications.status, "dismissed"));
    return this.db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(options.limit ?? 100).all().map(toView);
  }

  setStatus(userId: string, id: string, status: "read" | "dismissed"): void {
    const result = this.db.update(notifications).set({ status }).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).run();
    if (result.changes === 0) throw new LouError("NOT_FOUND", "Notification not found.");
  }
}

function toView(r: Row): NotificationView {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    source: r.source,
    category: r.category,
    importance: r.importance,
    status: r.status as NotificationView["status"],
    actions: r.actions as NotificationAction[],
    createdAt: r.createdAt,
  };
}
