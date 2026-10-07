import { LouError } from "@lou/shared";
import { fetchJson, type FetchLike } from "../http";
import type { RefreshResult } from "../manager";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/** Google OAuth 2.0 (authorization code + PKCE, offline access). */
export class GoogleOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTH_URL}?${params}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    return fetchJson<TokenResponse>(this.fetchImpl, TOKEN_URL, {
      service: "Google",
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  async refresh(refreshToken: string | null): Promise<RefreshResult> {
    if (!refreshToken) throw new LouError("AUTH_REQUIRED", "Gmail needs you to sign in again.");
    try {
      const res = await fetchJson<TokenResponse>(this.fetchImpl, TOKEN_URL, {
        service: "Google",
        body: new URLSearchParams({ refresh_token: refreshToken, client_id: this.clientId, client_secret: this.clientSecret, grant_type: "refresh_token" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      return { accessToken: res.access_token, refreshToken: res.refresh_token, expiresInSeconds: res.expires_in };
    } catch (err) {
      // invalid_grant = revoked or expired refresh token → user must reconnect.
      if (err instanceof LouError && (err.code === "AUTH_REQUIRED" || JSON.stringify(err.details ?? {}).includes("invalid_grant"))) {
        throw new LouError("AUTH_REQUIRED", "Gmail needs you to sign in again.");
      }
      throw err;
    }
  }

  /**
   * Checks the client ID and secret without user involvement. Google has no
   * client-credentials grant, so this redeems a deliberately invalid code: a
   * known client gets `invalid_grant`, an unknown one or a wrong secret gets
   * `invalid_client`.
   */
  async verifyCredentials(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ code: "lou-credential-check", client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: "authorization_code" }),
      });
    } catch (err) {
      throw new LouError("UPSTREAM_ERROR", "Google's sign-in service could not be reached. Check the server's internet connection and try again.", { cause: err });
    }
    const data = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
    const error = typeof data?.error === "string" ? data.error : "";
    if (error === "invalid_grant") return;
    if (error === "invalid_client" || error === "unauthorized_client") {
      throw new LouError("VALIDATION_FAILED", "Google rejected the Client ID or Client secret. Copy both again from the OAuth client in Google Cloud.");
    }
    if (error === "redirect_uri_mismatch") {
      throw new LouError("VALIDATION_FAILED", `The OAuth client doesn't list Lou's redirect URI. Add ${this.redirectUri} under Authorized redirect URIs.`);
    }
    if (res.status >= 500) throw new LouError("UPSTREAM_ERROR", "Google's sign-in service is having trouble right now. Try again shortly.");
    throw new LouError("UPSTREAM_ERROR", `Google couldn't check these credentials${error ? ` (${error.slice(0, 60)})` : ""}.`, { retryable: false });
  }

  async userInfo(accessToken: string): Promise<{ email: string; name?: string; sub: string }> {
    return fetchJson(this.fetchImpl, USERINFO_URL, { service: "Google", headers: { authorization: `Bearer ${accessToken}` } });
  }
}
