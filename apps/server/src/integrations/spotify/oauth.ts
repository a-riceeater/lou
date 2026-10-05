import type { FetchLike } from "../http";
import type { RefreshResult } from "../manager";
import { SpotifyError } from "./errors";
import { TokenResponseSchema, type SpotifyTokenResponse } from "./types";

/**
 * Only what implemented features need: player state/control, and the user's own
 * playlists so "play my Discover Weekly" can resolve private playlists.
 */
export const SPOTIFY_SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "playlist-read-private"] as const;
export const REQUIRED_SCOPES: readonly string[] = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"];

export const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

export interface SpotifyAppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Spotify OAuth 2.0 Authorization Code flow. Lou's server is the trusted,
 * confidential client: it holds the client secret, exchanges codes and refreshes
 * tokens. The secret never reaches devices, the UI bundle or the model.
 */
export class SpotifyOAuth {
  constructor(
    private readonly app: SpotifyAppCredentials,
    private readonly redirectUri: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authUrl(state: string, showDialog = false): string {
    const params = new URLSearchParams({
      client_id: this.app.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope: SPOTIFY_SCOPES.join(" "),
      state,
      ...(showDialog ? { show_dialog: "true" } : {}),
    });
    return `${SPOTIFY_AUTH_URL}?${params}`;
  }

  exchangeCode(code: string): Promise<SpotifyTokenResponse> {
    return this.token(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri }));
  }

  async refresh(refreshToken: string | null): Promise<RefreshResult> {
    if (!refreshToken) throw new SpotifyError("SPOTIFY_AUTH_EXPIRED", "Spotify needs you to sign in again.");
    const res = await this.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
    // Spotify may rotate the refresh token; the manager keeps the old one when none is returned.
    return { accessToken: res.access_token, refreshToken: res.refresh_token, expiresInSeconds: res.expires_in };
  }

  /** Verifies the app credentials (client credentials grant) without any user involvement. */
  async verifyCredentials(): Promise<void> {
    await this.token(new URLSearchParams({ grant_type: "client_credentials" }));
  }

  private async token(body: URLSearchParams): Promise<SpotifyTokenResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
    } catch (err) {
      throw new SpotifyError("SPOTIFY_UNAVAILABLE", "Spotify's sign-in service could not be reached.", { cause: err });
    }
    const data = (await res.json().catch(() => undefined)) as { error?: unknown; error_description?: unknown } | undefined;
    if (!res.ok) {
      const error = typeof data?.error === "string" ? data.error : "";
      const description = typeof data?.error_description === "string" ? data.error_description : "";
      if (error === "invalid_client") {
        throw new SpotifyError("SPOTIFY_NOT_CONFIGURED", "Spotify rejected the app's Client ID or Client secret. Check them in the Spotify Developer Dashboard.", { details: { status: res.status } });
      }
      if (error === "invalid_grant") {
        // Revoked/expired refresh token, or a reused/mismatched authorization code.
        throw new SpotifyError("SPOTIFY_AUTH_EXPIRED", /redirect/i.test(description) ? "Spotify sign-in failed: the redirect URI does not match the one registered for the app." : "Spotify needs you to sign in again.", {
          details: { status: res.status },
        });
      }
      if (res.status === 429) throw new SpotifyError("SPOTIFY_RATE_LIMITED", "Spotify is rate limiting sign-in requests. Try again shortly.");
      if (res.status >= 500) throw new SpotifyError("SPOTIFY_UNAVAILABLE", "Spotify's sign-in service is having trouble right now.", { details: { status: res.status } });
      throw new SpotifyError("SPOTIFY_API_ERROR", `Spotify sign-in failed${description ? `: ${description.slice(0, 160)}` : "."}`, { details: { status: res.status, error } });
    }
    const parsed = TokenResponseSchema.safeParse(data);
    if (!parsed.success) throw new SpotifyError("SPOTIFY_API_ERROR", "Spotify returned an unexpected sign-in response.");
    return parsed.data;
  }
}
