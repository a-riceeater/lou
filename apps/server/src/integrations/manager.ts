import { createHash } from "node:crypto";
import type { AccountProvider, AccountStatus, AccountView } from "@lou/protocol";
import { LouError, newId } from "@lou/shared";
import { and, eq, lt, sql } from "drizzle-orm";
import type { AuditLog } from "../core/audit";
import type { Db } from "../db/client";
import { accounts, oauthConnections, oauthStates } from "../db/schema";
import type { Logger } from "../logger";
import { randomToken, sha256Hex, type Vault } from "../security/crypto";

type AccountRow = typeof accounts.$inferSelect;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scopes?: string[];
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
}

/** Provider hook that refreshes an access token. Throws AUTH_REQUIRED when reauthorization is needed. */
export type TokenRefresher = (refreshToken: string | null, accessToken: string) => Promise<RefreshResult>;

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;

/**
 * Connected accounts (Gmail, Instagram, MCP) and their OAuth credentials.
 * Tokens are encrypted at rest and only ever leave this module as short-lived
 * values handed to integration clients — never to the model or the client UI.
 */
export class IntegrationManager {
  private readonly refreshers = new Map<string, TokenRefresher>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
  ) {}

  registerRefresher(provider: AccountProvider, refresher: TokenRefresher): void {
    this.refreshers.set(provider, refresher);
  }

  // ---- OAuth state (CSRF + PKCE) -------------------------------------------

  createOAuthState(userId: string, provider: AccountProvider, withPkce: boolean): { state: string; codeVerifier?: string; codeChallenge?: string } {
    const state = randomToken(24);
    const codeVerifier = withPkce ? randomToken(48) : undefined;
    this.db
      .insert(oauthStates)
      .values({
        id: newId("oas"),
        stateHash: sha256Hex(state),
        userId,
        provider,
        codeVerifierEnc: codeVerifier ? this.vault.encrypt(codeVerifier) : null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      })
      .run();
    this.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date().toISOString())).run();
    const codeChallenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
    return { state, codeVerifier, codeChallenge };
  }

  /** Validates and consumes a state value (single use). */
  consumeOAuthState(state: string | undefined, provider: AccountProvider): { userId: string; codeVerifier?: string } {
    if (!state) throw new LouError("UNAUTHORIZED", "Missing OAuth state.");
    const row = this.db.select().from(oauthStates).where(eq(oauthStates.stateHash, sha256Hex(state))).get();
    if (!row || row.provider !== provider || row.expiresAt < new Date().toISOString()) {
      throw new LouError("UNAUTHORIZED", "This sign-in link is invalid or expired. Start again from the app.");
    }
    this.db.delete(oauthStates).where(eq(oauthStates.id, row.id)).run();
    return { userId: row.userId, codeVerifier: row.codeVerifierEnc ? this.vault.decrypt(row.codeVerifierEnc) : undefined };
  }

  // ---- Accounts ---------------------------------------------------------------

  upsertAccount(input: {
    userId: string;
    provider: AccountProvider;
    externalId: string;
    displayName: string;
    address: string | null;
    capabilities: string[];
    metadata?: Record<string, unknown>;
  }): string {
    const existing = this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, input.userId), eq(accounts.provider, input.provider), eq(accounts.externalId, input.externalId)))
      .get();
    if (existing) {
      this.db
        .update(accounts)
        .set({
          displayName: input.displayName,
          address: input.address,
          capabilities: input.capabilities,
          status: "connected",
          lastError: null,
          metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
          updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        })
        .where(eq(accounts.id, existing.id))
        .run();
      return existing.id;
    }
    const id = newId("acc");
    this.db
      .insert(accounts)
      .values({ id, userId: input.userId, provider: input.provider, externalId: input.externalId, displayName: input.displayName, address: input.address, capabilities: input.capabilities, status: "connected", metadata: input.metadata ?? {} })
      .run();
    return id;
  }

  storeTokens(accountId: string, provider: AccountProvider, tokens: TokenSet): void {
    const values = {
      accessTokenEnc: this.vault.encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.vault.encrypt(tokens.refreshToken) : undefined,
      expiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes ?? [],
      updatedAt: new Date().toISOString(),
    };
    const existing = this.db.select().from(oauthConnections).where(eq(oauthConnections.accountId, accountId)).get();
    if (existing) {
      this.db
        .update(oauthConnections)
        .set({ ...values, refreshTokenEnc: values.refreshTokenEnc ?? existing.refreshTokenEnc })
        .where(eq(oauthConnections.id, existing.id))
        .run();
    } else {
      this.db.insert(oauthConnections).values({ id: newId("oac"), accountId, provider, ...values, refreshTokenEnc: values.refreshTokenEnc ?? null }).run();
    }
  }

  /** Returns a valid access token, refreshing (once, de-duplicated) if near expiry. */
  async accessToken(accountId: string): Promise<string> {
    const pending = this.inflight.get(accountId);
    if (pending) return pending;
    const promise = this.resolveToken(accountId).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, promise);
    return promise;
  }

  /** Forces a refresh (e.g. after a 401 from the provider). */
  async forceRefresh(accountId: string): Promise<string> {
    return this.resolveToken(accountId, true);
  }

  private async resolveToken(accountId: string, force = false): Promise<string> {
    const account = this.getRow(accountId);
    if (!account) throw new LouError("NOT_FOUND", "Account not found.");
    if (account.status === "disconnected") throw new LouError("AUTH_REQUIRED", `${account.displayName} is disconnected.`);
    const conn = this.db.select().from(oauthConnections).where(eq(oauthConnections.accountId, accountId)).get();
    if (!conn?.accessTokenEnc) throw new LouError("AUTH_REQUIRED", `${providerLabel(account.provider)} needs you to sign in again.`);
    const accessToken = this.vault.decrypt(conn.accessTokenEnc);
    const expiresAt = conn.expiresAt ? Date.parse(conn.expiresAt) : Number.POSITIVE_INFINITY;
    if (!force && expiresAt - REFRESH_SKEW_MS > Date.now()) return accessToken;

    const refresher = this.refreshers.get(account.provider);
    if (!refresher) return accessToken;
    try {
      const refreshed = await refresher(conn.refreshTokenEnc ? this.vault.decrypt(conn.refreshTokenEnc) : null, accessToken);
      this.storeTokens(accountId, account.provider as AccountProvider, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresInSeconds ? new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString() : null,
        scopes: conn.scopes,
      });
      if (account.status !== "connected") this.setStatus(accountId, "connected", null);
      return refreshed.accessToken;
    } catch (err) {
      const e = err instanceof LouError ? err : new LouError("UPSTREAM_ERROR", String(err));
      if (e.code === "AUTH_REQUIRED") {
        this.setStatus(accountId, "needs_reauth", e.message);
        this.audit.record({ userId: account.userId, actorType: "system", action: "account.refresh_failed", targetType: "account", targetId: accountId, details: { provider: account.provider } });
      }
      this.logger.warn({ accountId, code: e.code }, "token refresh failed");
      throw e;
    }
  }

  setStatus(accountId: string, status: AccountStatus, error: string | null): void {
    this.db
      .update(accounts)
      .set({ status, lastError: error, lastCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(accounts.id, accountId))
      .run();
  }

  updateMetadata(accountId: string, patch: Record<string, unknown>): void {
    const row = this.getRow(accountId);
    if (!row) return;
    this.db.update(accounts).set({ metadata: { ...row.metadata, ...patch } }).where(eq(accounts.id, accountId)).run();
  }

  getRow(accountId: string): AccountRow | undefined {
    return this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  }

  findByExternalId(provider: AccountProvider, externalId: string): AccountRow | undefined {
    return this.db.select().from(accounts).where(and(eq(accounts.provider, provider), eq(accounts.externalId, externalId))).get();
  }

  rows(userId: string, provider?: AccountProvider): AccountRow[] {
    const where = provider ? and(eq(accounts.userId, userId), eq(accounts.provider, provider)) : eq(accounts.userId, userId);
    return this.db.select().from(accounts).where(where).all();
  }

  allConnected(provider: AccountProvider): AccountRow[] {
    return this.db.select().from(accounts).where(and(eq(accounts.provider, provider), eq(accounts.status, "connected"))).all();
  }

  list(userId: string): AccountView[] {
    return this.rows(userId)
      .filter((r) => r.status !== "disconnected")
      .map((r) => ({
        id: r.id,
        provider: r.provider as AccountProvider,
        displayName: r.displayName,
        address: r.address,
        status: r.status as AccountStatus,
        capabilities: r.capabilities,
        lastCheckedAt: r.lastCheckedAt,
        lastError: r.lastError,
      }));
  }

  /**
   * Picks the account a tool call targets. The model may name one explicitly;
   * otherwise exactly one connected account of that provider must exist.
   */
  resolveAccount(userId: string, provider: AccountProvider, accountId: string | undefined): AccountRow {
    const candidates = this.rows(userId, provider).filter((r) => r.status !== "disconnected");
    if (accountId) {
      const match = candidates.find((r) => r.id === accountId || r.address?.toLowerCase() === accountId.toLowerCase());
      if (!match) throw new LouError("NOT_FOUND", `No connected ${providerLabel(provider)} account "${accountId}".`);
      return match;
    }
    if (candidates.length === 0) throw new LouError("NOT_CONFIGURED", `No ${providerLabel(provider)} account is connected. Connect one in Accounts.`);
    if (candidates.length > 1) {
      throw new LouError("VALIDATION_FAILED", `Several ${providerLabel(provider)} accounts are connected; specify accountId (${candidates.map((c) => `${c.id} = ${c.address}`).join(", ")}).`);
    }
    return candidates[0]!;
  }

  disconnect(userId: string, accountId: string, actor: { type: "user" | "device"; id?: string }): void {
    const row = this.getRow(accountId);
    if (!row || row.userId !== userId) throw new LouError("NOT_FOUND", "Account not found.");
    this.db.delete(oauthConnections).where(eq(oauthConnections.accountId, accountId)).run();
    this.setStatus(accountId, "disconnected", null);
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "account.disconnected", targetType: "account", targetId: accountId, details: { provider: row.provider } });
  }
}

export function providerLabel(provider: string): string {
  return provider === "google" ? "Gmail" : provider === "instagram" ? "Instagram" : provider.toUpperCase();
}
