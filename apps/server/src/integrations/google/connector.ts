import { LouError } from "@lou/shared";
import type { AuditLog } from "../../core/audit";
import type { FetchLike } from "../http";
import type { IntegrationManager } from "../manager";
import { GmailClient } from "./gmail";
import { GoogleOAuth } from "./oauth";

/** Connect/callback/health flow for Gmail accounts (multiple accounts supported). */
export class GoogleConnector {
  private readonly oauth: GoogleOAuth | undefined;

  constructor(
    options: { clientId?: string; clientSecret?: string; publicUrl: string },
    private readonly integrations: IntegrationManager,
    private readonly audit: AuditLog,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (options.clientId && options.clientSecret) {
      this.oauth = new GoogleOAuth(options.clientId, options.clientSecret, `${options.publicUrl}/oauth/google/callback`, fetchImpl);
      integrations.registerRefresher("google", (refreshToken) => this.oauth!.refresh(refreshToken));
    }
  }

  get configured(): boolean {
    return !!this.oauth;
  }

  startConnect(userId: string): { authUrl: string } {
    if (!this.oauth) throw new LouError("NOT_CONFIGURED", "Gmail isn't set up on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
    const { state, codeChallenge } = this.integrations.createOAuthState(userId, "google", true);
    return { authUrl: this.oauth.authUrl(state, codeChallenge!) };
  }

  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<{ accountId: string; email: string }> {
    if (!this.oauth) throw new LouError("NOT_CONFIGURED", "Gmail isn't configured on this server.");
    const { userId, codeVerifier } = this.integrations.consumeOAuthState(query.state, "google");
    if (query.error) throw new LouError("UNAUTHORIZED", query.error === "access_denied" ? "Access was not granted." : `Google returned: ${query.error}`);
    if (!query.code || !codeVerifier) throw new LouError("VALIDATION_FAILED", "Missing authorization code.");

    const tokens = await this.oauth.exchangeCode(query.code, codeVerifier);
    const scopes = tokens.scope?.split(" ") ?? [];
    if (!scopes.some((s) => s.endsWith("gmail.readonly")) || !scopes.some((s) => s.endsWith("gmail.compose"))) {
      throw new LouError("FORBIDDEN", "Gmail permissions were not granted. Please allow reading and sending email.");
    }
    const gmail = new GmailClient(async () => tokens.access_token, this.fetchImpl);
    const profile = await gmail.profile();
    const info = await this.oauth.userInfo(tokens.access_token).catch(() => undefined);

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
