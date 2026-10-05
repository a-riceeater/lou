import { LouError, type ErrorCode } from "@lou/shared";

/**
 * Spotify-specific failure reasons. They ride on Lou's shared error framework:
 * each maps to a generic {@link ErrorCode} (which clients and the policy layer
 * understand) and keeps the precise reason in `details.spotifyCode`.
 */
export const SPOTIFY_ERROR_CODES = {
  SPOTIFY_NOT_CONFIGURED: "NOT_CONFIGURED",
  SPOTIFY_NOT_CONNECTED: "NOT_CONFIGURED",
  SPOTIFY_AUTH_EXPIRED: "AUTH_REQUIRED",
  SPOTIFY_INSUFFICIENT_SCOPE: "AUTH_REQUIRED",
  SPOTIFY_USER_NOT_ALLOWED: "FORBIDDEN",
  SPOTIFY_PREMIUM_REQUIRED: "FORBIDDEN",
  SPOTIFY_RESTRICTED: "FORBIDDEN",
  SPOTIFY_NO_ACTIVE_DEVICE: "NOT_FOUND",
  SPOTIFY_DEVICE_NOT_FOUND: "NOT_FOUND",
  SPOTIFY_DEVICE_AMBIGUOUS: "VALIDATION_FAILED",
  SPOTIFY_NOTHING_FOUND: "NOT_FOUND",
  SPOTIFY_INVALID_REQUEST: "VALIDATION_FAILED",
  SPOTIFY_RATE_LIMITED: "RATE_LIMITED",
  SPOTIFY_UNAVAILABLE: "UPSTREAM_ERROR",
  SPOTIFY_API_ERROR: "UPSTREAM_ERROR",
} as const satisfies Record<string, ErrorCode>;

export type SpotifyErrorCode = keyof typeof SPOTIFY_ERROR_CODES;

export class SpotifyError extends LouError {
  readonly spotifyCode: SpotifyErrorCode;

  constructor(spotifyCode: SpotifyErrorCode, message: string, options: { details?: Record<string, unknown>; cause?: unknown; retryable?: boolean } = {}) {
    super(SPOTIFY_ERROR_CODES[spotifyCode], message, { ...options, details: { spotifyCode, ...options.details } });
    this.name = "SpotifyError";
    this.spotifyCode = spotifyCode;
  }
}

export function isSpotifyError(err: unknown, code?: SpotifyErrorCode): err is SpotifyError {
  return err instanceof SpotifyError && (!code || err.spotifyCode === code);
}

export const NOT_CONNECTED_MESSAGE = "Spotify isn't connected yet. Open Lou → Accounts → Spotify and choose Connect Spotify.";
export const RECONNECT_MESSAGE = "Spotify needs you to sign in again. Open Lou → Accounts → Spotify and choose Reconnect.";
