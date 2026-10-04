import { newId } from "@lou/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";

export interface User {
  id: string;
  name: string;
  timezone: string;
}

/**
 * Personal deployment: one owner account per server. The schema keeps user IDs on
 * every row so multi-user support can be added without migrations of meaning.
 */
export class UserStore {
  constructor(private readonly db: Db) {}

  ensureOwner(defaults: { name: string; timezone: string }): User {
    const existing = this.db.select().from(users).orderBy(asc(users.createdAt)).limit(1).get();
    if (existing) return existing;
    const user = { id: newId("usr"), name: defaults.name, timezone: defaults.timezone };
    this.db.insert(users).values(user).run();
    return user;
  }

  get(id: string): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }
}
