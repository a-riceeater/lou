import type { GoogleAppCredentialsRequest, GoogleSetupStatus } from "@lou/protocol";
import { LouError } from "@lou/shared";
import { z } from "zod";
import type { AuditLog } from "../../core/audit";
import type { SettingsStore } from "../../core/settings";
import type { Logger } from "../../logger";
import type { Vault } from "../../security/crypto";
import type { FetchLike } from "../http";
import type { IntegrationManager } from "../manager";
import { GmailClient } from "./gmail";
import { GOOGLE_SCOPES, GoogleOAuth } from "./oauth";

const APP_SETTING = "google_app";
const StoredApp = z.object({ clientId: z.string(), clientSecretEnc: z.string() });
const NOT_SET_UP = "Gmail isn't set up on this Lou server yet. Open Lou → Accounts → Set up Gmail.";

export interface GoogleConnectorOptions {
  /** From GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET; takes precedence over credentials saved from the UI. */
  clientId?: string;
  clientSecret?: string;
  publicUrl: string;
}

/**
 * Connect/callback/health flow for Gmail accounts (multiple accounts supported).
 * The Google OAuth client comes from the environment, or is entered once in the
 * setup dialog and stored with the secret encrypted.
 */
export class GoogleConnector {
  constructor(
    private readonly options: GoogleConnectorOptions,
    private readonly integrations: IntegrationManager,
    private readonly settings: SettingsStore,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    integrations.registerRefresher("google", (refreshToken) => this.requireOAuth().refresh(refreshToken));
  }

  get redirectUri(): string {
    return `${this.options.publicUrl}/oauth/google/callback`;
  }

  get configured(): boolean {
    return !!this.credentials();
  }

  // ---- App credentials ---------------------------------------------------------

  credentials(): { clientId: string; clientSecret: string; source: "env" | "server" } | undefined {
    if (this.options.clientId && this.options.clientSecret) return { clientId: this.options.clientId, clientSecret: this.options.clientSecret, source: "env" };
    const stored = this.settings.getValue(APP_SETTING, StoredApp);
    if (!stored) return undefined;
    try {
      return { clientId: stored.clientId, clientSecret: this.vault.decrypt(stored.clientSecretEnc), source: "server" };
    } catch {
      this.logger.warn("stored Google OAuth client could not be decrypted");
      return undefined;
    }
  }

  /** Verifies the credentials with Google, then stores them (secret encrypted). Environment configuration wins and cannot be overwritten here. */
  async saveAppCredentials(userId: string, input: GoogleAppCredentialsRequest, actor: { type: "device"; id: string }): Promise<void> {
    if (this.credentials()?.source === "env") {
      throw new LouError("CONFLICT", "Gmail is configured in the server environment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Change it there instead.");
    }
    await new GoogleOAuth(input.clientId, input.clientSecret, this.redirectUri, this.fetchImpl).verifyCredentials();
    const previous = this.settings.getValue(APP_SETTING, StoredApp);
    this.settings.setValue(APP_SETTING, { clientId: input.clientId, clientSecretEnc: this.vault.encrypt(input.clientSecret) });
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "integration.configured", details: { provider: "google", clientId: input.clientId } });
    // Refresh tokens issued to a different OAuth client can't be used with the new one.
    if (previous && previous.clientId !== input.clientId) {
      for (const row of this.accounts(userId)) this.integrations.setStatus(row.id, "needs_reauth", "The Google OAuth client changed. Reconnect this Gmail account.");
    }
  }

  clearAppCredentials(userId: string, actor: { type: "device"; id: string }): void {
    if (this.credentials()?.source === "env") throw new LouError("CONFLICT", "Gmail is configured in the server environment; remove GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET there.");
    this.settings.deleteValue(APP_SETTING);
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "integration.unconfigured", details: { provider: "google" } });
  }

  status(): GoogleSetupStatus {
    const creds = this.credentials();
    return { configSource: creds?.source ?? null, clientId: creds?.clientId ?? null, redirectUri: this.redirectUri, scopes: [...GOOGLE_SCOPES] };
  }

  private requireOAuth(): GoogleOAuth {
    const creds = this.credentials();
    if (!creds) throw new LouError("NOT_CONFIGURED", NOT_SET_UP);
    return new GoogleOAuth(creds.clientId, creds.clientSecret, this.redirectUri, this.fetchImpl);
  }

  private accounts(userId: string) {
    return this.integrations.rows(userId, "google").filter((r) => r.status !== "disconnected" && r.metadata.connectionMethod !== "appscript");
  }

  // ---- OAuth -------------------------------------------------------------------------

  startConnect(userId: string): { authUrl: string } {
    const oauth = this.requireOAuth();
    const { state, codeChallenge } = this.integrations.createOAuthState(userId, "google", true);
    return { authUrl: oauth.authUrl(state, codeChallenge!) };
  }

  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<{ accountId: string; email: string }> {
    const oauth = this.requireOAuth();
    const { userId, codeVerifier } = this.integrations.consumeOAuthState(query.state, "google");
    if (query.error) throw new LouError("UNAUTHORIZED", query.error === "access_denied" ? "Access was not granted." : `Google returned: ${query.error}`);
    if (!query.code || !codeVerifier) throw new LouError("VALIDATION_FAILED", "Missing authorization code.");

    const tokens = await oauth.exchangeCode(query.code, codeVerifier);
    const scopes = tokens.scope?.split(" ") ?? [];
    if (!scopes.some((s) => s.endsWith("gmail.readonly")) || !scopes.some((s) => s.endsWith("gmail.compose"))) {
      throw new LouError("FORBIDDEN", "Gmail permissions were not granted. Please allow reading and sending email.");
    }
    const gmail = new GmailClient(async () => tokens.access_token, this.fetchImpl);
    const profile = await gmail.profile();
    const info = await oauth.userInfo(tokens.access_token).catch(() => undefined);

    const accountId = this.integrations.upsertAccount({
      userId,
      provider: "google",
      externalId: profile.emailAddress.toLowerCase(),
      displayName: info?.name ?? profile.emailAddress,
      address: profile.emailAddress.toLowerCase(),
      capabilities: ["search", "read", "draft", "reply", "send"],
      metadata: { historyId: profile.historyId },
    });
    this.integrations.storeTokens(accountId, "google", {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      scopes,
    });
    this.audit.record({ userId, actorType: "user", actorId: userId, action: "account.connected", targetType: "account", targetId: accountId, details: { provider: "google", email: profile.emailAddress, scopes } });
    return { accountId, email: profile.emailAddress };
  }

  async checkHealth(accountId: string): Promise<void> {
    const gmail = new GmailClient((force) => (force ? this.integrations.forceRefresh(accountId) : this.integrations.accessToken(accountId)), this.fetchImpl);
    try {
      await gmail.profile();
      this.integrations.setStatus(accountId, "connected", null);
    } catch (err) {
      const e = err instanceof LouError ? err : new LouError("UPSTREAM_ERROR", String(err));
      this.integrations.setStatus(accountId, e.code === "AUTH_REQUIRED" ? "needs_reauth" : "error", e.message);
      throw e;
    }
  }
}
