import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db → ../../drizzle ; dist → ./drizzle (copied at build time)
  for (const candidate of [resolve(here, "../../drizzle"), resolve(here, "drizzle"), resolve(here, "../drizzle")]) {
    if (existsSync(resolve(candidate, "meta/_journal.json"))) return candidate;
  }
  throw new Error("Could not locate database migrations folder");
}

/** Opens the database, applies pending migrations, and returns a typed client. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}

export { schema };
