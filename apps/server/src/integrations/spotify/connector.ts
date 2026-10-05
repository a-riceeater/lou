import type { SpotifyAppCredentialsRequest, SpotifyStatus } from "@lou/protocol";
import { LouError } from "@lou/shared";
import { z } from "zod";
import type { AuditLog } from "../../core/audit";
import type { SettingsStore } from "../../core/settings";
import type { Logger } from "../../logger";
import type { Vault } from "../../security/crypto";
import type { FetchLike } from "../http";
import type { IntegrationManager } from "../manager";
import { SpotifyApi, type SpotifyApiOptions } from "./client";
import { NOT_CONNECTED_MESSAGE, RECONNECT_MESSAGE, SpotifyError } from "./errors";
import { REQUIRED_SCOPES, SPOTIFY_SCOPES, SpotifyOAuth, type SpotifyAppCredentials } from "./oauth";

const APP_SETTING = "spotify_app";
const StoredApp = z.object({ clientId: z.string(), clientSecretEnc: z.string() });

export interface SpotifyConnectorOptions {
  /** From SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET; takes precedence over credentials saved from the UI. */
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  api?: SpotifyApiOptions;
}

type AccountRow = NonNullable<ReturnType<IntegrationManager["getRow"]>>;

/**
 * Spotify account connection: app credentials (environment, or entered once in
 * the setup dialog and stored encrypted), the OAuth Authorization Code flow,
 * token refresh, and connection status. Playback lives in {@link SpotifyPlayer}.
 */
export class SpotifyConnector {
  constructor(
    private readonly options: SpotifyConnectorOptions,
    private readonly integrations: IntegrationManager,
    private readonly settings: SettingsStore,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    integrations.registerRefresher("spotify", (refreshToken) => this.requireOAuth().refresh(refreshToken));
  }

  get redirectUri(): string {
    return this.options.redirectUri;
  }

  get configured(): boolean {
    return !!this.credentials();
  }

  // ---- App credentials ---------------------------------------------------------

  credentials(): (SpotifyAppCredentials & { source: "env" | "server" }) | undefined {
    if (this.options.clientId && this.options.clientSecret) return { clientId: this.options.clientId, clientSecret: this.options.clientSecret, source: "env" };
    const stored = this.settings.getValue(APP_SETTING, StoredApp);
    if (!stored) return undefined;
    try {
      return { clientId: stored.clientId, clientSecret: this.vault.decrypt(stored.clientSecretEnc), source: "server" };
    } catch {
      this.logger.warn("stored Spotify app credentials could not be decrypted");
      return undefined;
    }
  }

  /** Verifies the credentials with Spotify, then stores them (secret encrypted). Environment configuration wins and cannot be overwritten here. */
  async saveAppCredentials(userId: string, input: SpotifyAppCredentialsRequest, actor: { type: "device"; id: string }): Promise<void> {
    if (this.credentials()?.source === "env") {
      throw new LouError("CONFLICT", "Spotify is configured in the server environment (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET). Change it there instead.");
    }
    await new SpotifyOAuth(input, this.options.redirectUri, this.fetchImpl).verifyCredentials();
    const previous = this.settings.getValue(APP_SETTING, StoredApp);
    this.settings.setValue(APP_SETTING, { clientId: input.clientId, clientSecretEnc: this.vault.encrypt(input.clientSecret) });
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "integration.configured", details: { provider: "spotify", clientId: input.clientId } });
    // Tokens issued to a different app can't be refreshed by the new one.
    if (previous && previous.clientId !== input.clientId) {
      for (const row of this.accounts(userId)) this.integrations.setStatus(row.id, "needs_reauth", "The Spotify app changed. Reconnect Spotify.");
    }
  }

  clearAppCredentials(userId: string, actor: { type: "device"; id: string }): void {
    if (this.credentials()?.source === "env") throw new LouError("CONFLICT", "Spotify is configured in the server environment; remove SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET there.");
    this.settings.deleteValue(APP_SETTING);
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "integration.unconfigured", details: { provider: "spotify" } });
  }

  private requireOAuth(): SpotifyOAuth {
    const creds = this.credentials();
    if (!creds) throw new SpotifyError("SPOTIFY_NOT_CONFIGURED", "Spotify isn't set up on this Lou server yet. Open Lou → Accounts → Spotify → Set up.");
    return new SpotifyOAuth(creds, this.options.redirectUri, this.fetchImpl);
  }

  // ---- OAuth -------------------------------------------------------------------------

  startConnect(userId: string): { authUrl: string } {
    const oauth = this.requireOAuth();
    const { state } = this.integrations.createOAuthState(userId, "spotify", false);
    // Show Spotify's account chooser when reconnecting so a different account can be picked.
    return { authUrl: oauth.authUrl(state, this.accounts(userId).length > 0) };
  }

  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<{ accountId: string; displayName: string }> {
    const oauth = this.requireOAuth();
    const { userId } = this.integrations.consumeOAuthState(query.state, "spotify");
    if (query.error) throw new LouError("UNAUTHORIZED", query.error === "access_denied" ? "Access was not granted." : `Spotify returned: ${query.error.slice(0, 80)}`);
    if (!query.code) throw new LouError("VALIDATION_FAILED", "Missing authorization code.");

    const tokens = await oauth.exchangeCode(query.code);
    const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [...SPOTIFY_SCOPES];
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) throw new SpotifyError("SPOTIFY_INSUFFICIENT_SCOPE", `Spotify didn't grant the permissions Lou needs (${missing.join(", ")}). Try connecting again.`);
    if (!tokens.refresh_token) throw new SpotifyError("SPOTIFY_API_ERROR", "Spotify didn't return a refresh token. Try connecting again.");

    const me = await new SpotifyApi(async () => tokens.access_token, this.fetchImpl).me();
    const displayName = me.display_name?.trim() || me.id;
    const accountId = this.integrations.upsertAccount({
      userId,
      provider: "spotify",
      externalId: me.id,
      displayName,
      address: null,
      capabilities: ["playback", "devices", "search", "queue"],
      metadata: { spotifyUserId: me.id },
    });
    this.integrations.storeTokens(accountId, "spotify", {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      scopes,
    });
    // Lou controls one Spotify account at a time; connecting another replaces it.
    for (const other of this.accounts(userId)) {
      if (other.id !== accountId) this.integrations.disconnect(userId, other.id, { type: "user", id: userId });
    }
    this.audit.record({ userId, actorType: "user", actorId: userId, action: "account.connected", targetType: "account", targetId: accountId, details: { provider: "spotify", spotifyUserId: me.id, scopes } });
    return { accountId, displayName };
  }

  // ---- Accounts & status -----------------------------------------------------------

  accounts(userId: string): AccountRow[] {
    return this.integrations.rows(userId, "spotify").filter((r) => r.status !== "disconnected");
  }

  /** The connected account for a user, or a typed error explaining what to do. */
  requireAccount(userId: string): AccountRow {
    if (!this.configured) throw new SpotifyError("SPOTIFY_NOT_CONFIGURED", "Spotify isn't set up on this Lou server yet. Open Lou → Accounts → Spotify → Set up.");
    const account = this.accounts(userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!account) throw new SpotifyError("SPOTIFY_NOT_CONNECTED", NOT_CONNECTED_MESSAGE);
    // A revoked grant or missing scope needs the user; don't keep hitting Spotify.
    if (account.status === "needs_reauth") throw new SpotifyError("SPOTIFY_AUTH_EXPIRED", RECONNECT_MESSAGE);
    return account;
  }

  api(accountId: string): SpotifyApi {
    return new SpotifyApi((force) => (force ? this.integrations.forceRefresh(accountId) : this.integrations.accessToken(accountId)), this.fetchImpl, {
      ...this.options.api,
      onAuthRevoked: () => this.integrations.setStatus(accountId, "needs_reauth", "Spotify authorization was revoked or expired."),
    });
  }

  status(userId: string): SpotifyStatus {
    const creds = this.credentials();
    const account = this.accounts(userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const state: SpotifyStatus["state"] = !creds
      ? "not_configured"
      : !account
        ? "disconnected"
        : account.status === "needs_reauth"
          ? "needs_reauth"
          : account.status === "error"
            ? "unavailable"
            : "connected";
    return {
      state,
      configSource: creds?.source ?? null,
      clientId: creds?.clientId ?? null,
      redirectUri: this.options.redirectUri,
      scopes: [...SPOTIFY_SCOPES],
      account: account ? { id: account.id, displayName: account.displayName, spotifyUserId: account.externalId ?? "" } : null,
      lastError: account?.lastError ?? null,
    };
  }

  async checkHealth(accountId: string): Promise<void> {
    try {
      await this.api(accountId).me();
      this.integrations.setStatus(accountId, "connected", null);
    } catch (err) {
      const e = err instanceof LouError ? err : new LouError("UPSTREAM_ERROR", String(err));
      this.integrations.setStatus(accountId, e.code === "AUTH_REQUIRED" ? "needs_reauth" : "error", e.message);
      throw e;
    }
  }
}
