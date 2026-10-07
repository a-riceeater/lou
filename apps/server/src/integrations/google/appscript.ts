import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { LouError, newId } from "@lou/shared";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, gmailScriptCommands as commands, gmailScriptConnections as connections, gmailScriptMessages as messages } from "../../db/schema";
import type { EventManager } from "../../events/manager";
import { randomToken, sha256Hex } from "../../security/crypto";
import type { IntegrationManager } from "../manager";
import { generateGmailScript } from "./script";
import { CommandInput, resultSchema, type ScriptCommandInput } from "./script-protocol";

/** Scoped transport: bearer credentials authorize only these installation endpoints. */
export class GmailAppsScript {
  constructor(private readonly db: Db, private readonly integrations: IntegrationManager, private readonly events: EventManager, private readonly serverUrl: string, private readonly monitoringEnabled: () => boolean) {}

  create(userId: string, resetId?: string) {
    if (new URL(this.serverUrl).protocol !== "https:") throw new LouError("NOT_CONFIGURED", "Apps Script requires an HTTPS Lou public URL reachable from Google. Set LOU_PUBLIC_URL first.");
    const id = resetId ?? newId("acc");
    if (resetId) this.owned(userId, resetId);
    const secret = randomToken(32);
    this.db.transaction(() => {
      if (!resetId) this.db.insert(accounts).values({ id, userId, provider: "google", externalId: `appscript:${id}`, displayName: "Gmail via Apps Script", status: "pending", capabilities: ["search", "read", "draft", "reply", "send", "modify", "attachments"], metadata: { connectionMethod: "appscript", protocolVersion: 1 } }).run();
      this.db.insert(connections).values({ accountId: id, secretHash: sha256Hex(secret) }).onConflictDoUpdate({ target: connections.accountId, set: { secretHash: sha256Hex(secret), revokedAt: null } }).run();
      this.db.update(commands).set({ status: "failed", error: "Connection reset" }).where(and(eq(commands.accountId, id), inArray(commands.status, ["pending", "claimed"]))).run();
      this.integrations.setStatus(id, "pending", null);
      this.integrations.updateMetadata(id, { lastHeartbeat: null, lastSyncedAt: null, syncState: "waiting" });
    });
    return { accountId: id, script: generateGmailScript(this.serverUrl, id, secret) };
  }

  owned(userId: string, id: string) {
    const row = this.integrations.getRow(id);
    if (!row || row.userId !== userId || row.metadata.connectionMethod !== "appscript") throw new LouError("NOT_FOUND", "Gmail script account not found.");
    return row;
  }

  authenticate(id: string, bearer: string | undefined) {
    const row = this.db.select().from(connections).where(eq(connections.accountId, id)).get();
    const account = this.integrations.getRow(id);
    const hash = Buffer.from(sha256Hex(bearer ?? ""));
    if (!row || row.revokedAt || !account || account.status === "disconnected" || !timingSafeEqual(hash, Buffer.from(row.secretHash))) throw new LouError("UNAUTHORIZED", "Invalid or revoked Gmail script credential.");
    return account;
  }

  register(id: string, address?: string) {
    const row = this.integrations.getRow(id)!;
    if (row.address && address && row.address !== address) throw new LouError("CONFLICT", "This integration belongs to a different Gmail address. Create a new connection.");
    if (address) this.db.update(accounts).set({ address, displayName: address }).where(eq(accounts.id, id)).run();
    this.heartbeat(id, "syncing");
    return { ok: true, protocolVersion: 1 };
  }

  heartbeat(id: string, state: "syncing" | "connected" | "error" | "authorization_required", error?: string) {
    this.integrations.updateMetadata(id, { lastHeartbeat: new Date().toISOString(), syncState: state });
    this.integrations.setStatus(id, state === "authorization_required" ? "needs_reauth" : state === "error" ? "error" : "connected", error ?? null);
    return { ok: true };
  }

  async sync(id: string, batch: Array<Record<string, unknown>>, cursor: string) {
    const account = this.integrations.getRow(id)!;
    for (const message of batch) {
      this.db.insert(messages).values({ accountId: id, messageId: String(message.id), data: message }).onConflictDoUpdate({ target: [messages.accountId, messages.messageId], set: { data: message, updatedAt: new Date().toISOString() } }).run();
      // EventManager has a durable unique externalId; retries after interrupted ingestion are safe.
      if (this.monitoringEnabled() && (message.labelIds as string[]).includes("INBOX") && !(message.labelIds as string[]).includes("SENT")) await this.events.ingest({ userId: account.userId, source: "gmail", accountId: id, type: "email.received", externalId: `gmail:${id}:${message.id}`, trust: "external-untrusted", occurredAt: Number.isFinite(Date.parse(String(message.date))) ? new Date(String(message.date)).toISOString() : new Date().toISOString(), payload: { messageId: message.id, threadId: message.threadId, from: message.from, subject: message.subject, snippet: message.snippet, labelIds: message.labelIds, bulk: message.bulk } });
    }
    this.integrations.updateMetadata(id, { lastSyncedAt: new Date().toISOString(), syncCursor: cursor });
    return this.heartbeat(id, "connected");
  }

  pending(id: string) {
    this.expire(id);
    return { commands: this.db.select({ id: commands.id, input: commands.input, expiresAt: commands.expiresAt }).from(commands).where(and(eq(commands.accountId, id), eq(commands.status, "pending"), gt(commands.expiresAt, new Date().toISOString()))).limit(5).all() };
  }

  claim(accountId: string, id: string) {
    const row = this.db.update(commands).set({ status: "claimed" }).where(and(eq(commands.id, id), eq(commands.accountId, accountId), eq(commands.status, "pending"), gt(commands.expiresAt, new Date().toISOString()))).returning({ id: commands.id }).get();
    return { execute: !!row };
  }

  complete(accountId: string, id: string, result: unknown, error?: string) {
    const row = this.db.select().from(commands).where(and(eq(commands.id, id), eq(commands.accountId, accountId))).get();
    if (!row) throw new LouError("NOT_FOUND", "Command not found.");
    if (row.status === "completed" || row.status === "failed") return { ok: true };
    if (row.status !== "claimed") throw new LouError("CONFLICT", "Command has not been claimed.");
    const parsed = error ? null : resultSchema(row.operation).parse(result);
    this.db.update(commands).set({ status: error ? "failed" : "completed", result: parsed, error: error ?? null, completedAt: new Date().toISOString() }).where(eq(commands.id, id)).run();
    return { ok: true };
  }

  expire(accountId: string) {
    this.db.update(commands).set({ status: "failed", error: "Command expired; execution outcome may be unknown. Check Gmail before sending again." }).where(and(eq(commands.accountId, accountId), inArray(commands.status, ["pending", "claimed"]), gt(new Date().toISOString(), commands.expiresAt))).run();
  }

  enqueue(accountId: string, input: ScriptCommandInput) {
    const row = this.integrations.getRow(accountId);
    if (!row || row.status === "disconnected" || row.metadata.connectionMethod !== "appscript") throw new LouError("AUTH_REQUIRED", "Gmail script is disconnected.");
    const parsed = CommandInput.parse(input);
    const id = newId("gsc");
    this.db.insert(commands).values({ id, accountId, operation: parsed.operation, input: parsed, expiresAt: new Date(Date.now() + 120_000).toISOString() }).run();
    return id;
  }

  async execute<T>(accountId: string, input: ScriptCommandInput, signal?: AbortSignal): Promise<T> {
    const id = this.enqueue(accountId, input);
    try {
      for (;;) {
        this.expire(accountId);
        const row = this.db.select().from(commands).where(eq(commands.id, id)).get()!;
        if (row.status === "completed") return row.result as T;
        if (row.status === "failed") throw new LouError("UPSTREAM_ERROR", row.error ?? "Gmail command failed.");
        await sleep(500, undefined, { signal });
      }
    } finally {
      // A canceled tool must not execute later if it has not yet been claimed.
      this.db.update(commands).set({ status: "failed", error: "Request canceled" }).where(and(eq(commands.id, id), eq(commands.status, "pending"))).run();
    }
  }
}
