import { LouError } from "@lou/shared";
import type { z } from "zod";
import type { FetchLike } from "../http";
import { SpotifyError } from "./errors";
import {
  DevicesSchema,
  MeSchema,
  PlaybackStateSchema,
  PlaylistPageSchema,
  QueueSchema,
  SearchSchema,
  type RepeatState,
  type SearchType,
  type SpotifyDevice,
  type SpotifyMe,
  type SpotifyPlaybackState,
  type SpotifyPlaylist,
  type SpotifyQueue,
  type SpotifySearchResponse,
} from "./types";

export const SPOTIFY_API = "https://api.spotify.com/v1";

/** Returns an access token; `true` asks for a forced refresh after a 401. */
export type TokenSource = (forceRefresh: boolean) => Promise<string>;

export interface SpotifyApiOptions {
  /** Longest `Retry-After` the client waits out itself before reporting RATE_LIMITED. */
  maxRateLimitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called when Spotify rejects even a freshly refreshed token (authorization revoked). */
  onAuthRevoked?: () => void;
}

interface RequestOptions<S extends z.ZodTypeAny | undefined> {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  schema?: S;
  signal?: AbortSignal;
}

const RESTRICTION_REASONS = new Set(["REMOTE_CONTROL_DISALLOW", "DEVICE_NOT_CONTROLLABLE", "VOLUME_CONTROL_DISALLOW", "CONTEXT_DISALLOW", "ENDLESS_CONTEXT", "NOT_PLAYING_LOCALLY", "NOT_PLAYING_TRACK", "NOT_PLAYING_CONTEXT", "NO_PREV_TRACK", "NO_NEXT_TRACK", "NO_SPECIFIC_TRACK", "ALREADY_PAUSED", "NOT_PAUSED", "ALREADY_PLAYING"]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The single place Lou talks HTTP to the Spotify Web API. Handles bearer
 * tokens (with one forced refresh on 401), `Retry-After` on 429, a single retry
 * of idempotent reads on transient failures, Spotify's error format, and schema
 * validation of every response it returns. Player mutations are never retried
 * after an ambiguous failure, so a command is never applied twice.
 */
export class SpotifyApi {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;

  constructor(
    private readonly token: TokenSource,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly options: SpotifyApiOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.maxWaitMs = options.maxRateLimitWaitMs ?? 5_000;
  }

  // ---- Reads -------------------------------------------------------------------

  me(signal?: AbortSignal): Promise<SpotifyMe> {
    return this.require(this.request("GET", "/me", { schema: MeSchema, signal }));
  }

  /** Full player state, or null when nothing is active (Spotify answers 204). */
  async playbackState(signal?: AbortSignal): Promise<SpotifyPlaybackState | null> {
    return (await this.request("GET", "/me/player", { query: { additional_types: "track,episode" }, schema: PlaybackStateSchema, signal })) ?? null;
  }

  async devices(signal?: AbortSignal): Promise<SpotifyDevice[]> {
    return (await this.require(this.request("GET", "/me/player/devices", { schema: DevicesSchema, signal }))).devices;
  }

  async queue(signal?: AbortSignal): Promise<SpotifyQueue> {
    return (await this.request("GET", "/me/player/queue", { schema: QueueSchema, signal })) ?? { currently_playing: null, queue: [] };
  }

  search(q: string, types: readonly SearchType[], limit: number, signal?: AbortSignal): Promise<SpotifySearchResponse> {
    // Development-mode apps may request at most 10 results per type.
    return this.require(this.request("GET", "/search", { query: { q, type: types.join(","), limit: Math.min(Math.max(limit, 1), 10) }, schema: SearchSchema, signal }));
  }

  async myPlaylists(limit: number, offset: number, signal?: AbortSignal): Promise<{ items: SpotifyPlaylist[]; next: boolean }> {
    const page = await this.require(this.request("GET", "/me/playlists", { query: { limit, offset }, schema: PlaylistPageSchema, signal }));
    return { items: page.items, next: !!page.next };
  }

  // ---- Player mutations ------------------------------------------------------------

  async play(target: { deviceId?: string; uris?: string[]; contextUri?: string; offsetUri?: string; positionMs?: number }, signal?: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = {};
    if (target.contextUri) body.context_uri = target.contextUri;
    if (target.uris) body.uris = target.uris;
    if (target.offsetUri) body.offset = { uri: target.offsetUri };
    if (target.positionMs !== undefined) body.position_ms = target.positionMs;
    await this.request("PUT", "/me/player/play", { query: { device_id: target.deviceId }, json: Object.keys(body).length ? body : undefined, signal });
  }

  async pause(deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", "/me/player/pause", { query: { device_id: deviceId }, signal });
  }

  async next(deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/me/player/next", { query: { device_id: deviceId }, signal });
  }

  async previous(deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/me/player/previous", { query: { device_id: deviceId }, signal });
  }

  async seek(positionMs: number, deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", "/me/player/seek", { query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId }, signal });
  }

  async setVolume(percent: number, deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", "/me/player/volume", { query: { volume_percent: Math.round(percent), device_id: deviceId }, signal });
  }

  async setShuffle(state: boolean, deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", "/me/player/shuffle", { query: { state, device_id: deviceId }, signal });
  }

  async setRepeat(state: RepeatState, deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", "/me/player/repeat", { query: { state, device_id: deviceId }, signal });
  }

  async addToQueue(uri: string, deviceId?: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/me/player/queue", { query: { uri, device_id: deviceId }, signal });
  }

  async transfer(deviceId: string, play: boolean | undefined, signal?: AbortSignal): Promise<void> {
    await this.request("PUT", "/me/player", { json: { device_ids: [deviceId], ...(play === undefined ? {} : { play }) }, signal });
  }

  // ---- Transport ------------------------------------------------------------------

  private async require<T>(promise: Promise<T | undefined>): Promise<T> {
    const value = await promise;
    if (value === undefined) throw new SpotifyError("SPOTIFY_API_ERROR", "Spotify returned an empty response.");
    return value;
  }

  private async request<S extends z.ZodTypeAny | undefined = undefined>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    options: RequestOptions<S> = {},
  ): Promise<(S extends z.ZodTypeAny ? z.infer<S> : unknown) | undefined> {
    const url = new URL(`${SPOTIFY_API}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const idempotentRead = method === "GET";
    let forcedRefresh = false;
    let rateLimitRetries = 0;
    let transientRetries = 0;

    for (;;) {
      const token = await this.token(forcedRefresh);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(options.json !== undefined ? { "content-type": "application/json" } : {}) },
          body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
          signal: options.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") throw new LouError("CANCELLED", "Cancelled.");
        if (idempotentRead && transientRetries++ < 1) {
          await this.sleep(300);
          continue;
        }
        throw new SpotifyError("SPOTIFY_UNAVAILABLE", "Spotify could not be reached. Check the server's internet connection and try again.", { cause: err });
      }

      if (res.status === 401 && !forcedRefresh) {
        forcedRefresh = true;
        continue;
      }
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        // A 429 means Spotify did not apply the request, so waiting and resending is safe.
        if (rateLimitRetries++ < 2 && retryAfter * 1000 <= this.maxWaitMs) {
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new SpotifyError("SPOTIFY_RATE_LIMITED", `Spotify is rate limiting requests. Try again in about ${formatWait(retryAfter)}.`, { details: { retryAfterSeconds: retryAfter } });
      }
      if (res.status >= 500 && idempotentRead && transientRetries++ < 1) {
        await this.sleep(500);
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw this.toError(res.status, text, path);
      if (!options.schema || res.status === 204 || !text.trim()) return undefined;

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new SpotifyError("SPOTIFY_API_ERROR", "Spotify returned a malformed response.", { details: { path, status: res.status } });
      }
      const parsed = options.schema.safeParse(data);
      if (!parsed.success) {
        throw new SpotifyError("SPOTIFY_API_ERROR", "Spotify returned an unexpected response.", { details: { path, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) } });
      }
      return parsed.data as S extends z.ZodTypeAny ? z.infer<S> : unknown;
    }
  }

  private toError(status: number, text: string, path: string): SpotifyError {
    let message = "";
    let reason = "";
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown; reason?: unknown } | string; error_description?: unknown };
      if (body.error && typeof body.error === "object") {
        message = typeof body.error.message === "string" ? body.error.message : "";
        reason = typeof body.error.reason === "string" ? body.error.reason : "";
      } else if (typeof body.error === "string") {
        message = typeof body.error_description === "string" ? body.error_description : body.error;
      }
    } catch {
      message = text.slice(0, 200);
    }
    // Raw Spotify text stays in details for diagnostics; messages are written for people.
    const details = { status, reason: reason || undefined, spotifyMessage: message.slice(0, 200) || undefined, path };

    if (status === 401) {
      this.options.onAuthRevoked?.();
      return new SpotifyError("SPOTIFY_AUTH_EXPIRED", "Spotify needs you to sign in again. Open Lou → Accounts → Spotify and choose Reconnect.", { details });
    }
    if (status === 403) {
      if (reason === "PREMIUM_REQUIRED" || /premium/i.test(message)) {
        return new SpotifyError("SPOTIFY_PREMIUM_REQUIRED", "Controlling playback needs Spotify Premium on the connected account.", { details });
      }
      if (/scope/i.test(message)) {
        return new SpotifyError("SPOTIFY_INSUFFICIENT_SCOPE", "Spotify permissions are missing. Reconnect Spotify in Lou → Accounts and allow access.", { details });
      }
      if (/not registered|developer dashboard|user may not be registered/i.test(message)) {
        return new SpotifyError("SPOTIFY_USER_NOT_ALLOWED", "This Spotify account isn't on the app's user list. Add it under User Management in the Spotify Developer Dashboard.", { details });
      }
      if (RESTRICTION_REASONS.has(reason) || /restrict/i.test(message)) {
        return new SpotifyError("SPOTIFY_RESTRICTED", restrictionMessage(reason), { details });
      }
      return new SpotifyError("SPOTIFY_RESTRICTED", "Spotify refused that command.", { details });
    }
    if (status === 404) {
      if (reason === "NO_ACTIVE_DEVICE" || /no active device/i.test(message)) {
        return new SpotifyError("SPOTIFY_NO_ACTIVE_DEVICE", "No Spotify device is currently active.", { details });
      }
      if (/device not found/i.test(message)) {
        return new SpotifyError("SPOTIFY_DEVICE_NOT_FOUND", "That Spotify device is no longer available. It may have gone to sleep or closed Spotify.", { details });
      }
      return new SpotifyError("SPOTIFY_NOTHING_FOUND", "Spotify couldn't find that.", { details });
    }
    if (status === 400) return new SpotifyError("SPOTIFY_INVALID_REQUEST", `Spotify rejected the request${message ? `: ${message.slice(0, 160)}` : "."}`, { details });
    if (status >= 500) return new SpotifyError("SPOTIFY_UNAVAILABLE", "Spotify is having trouble right now. Try again in a moment.", { details });
    return new SpotifyError("SPOTIFY_API_ERROR", `Spotify returned an error (${status}).`, { details });
  }
}

function restrictionMessage(reason: string): string {
  switch (reason) {
    case "NO_PREV_TRACK":
      return "There's no previous track to go back to.";
    case "NO_NEXT_TRACK":
      return "There's no next track to skip to.";
    case "VOLUME_CONTROL_DISALLOW":
      return "This Spotify device doesn't allow its volume to be changed remotely.";
    case "REMOTE_CONTROL_DISALLOW":
    case "DEVICE_NOT_CONTROLLABLE":
      return "This Spotify device can't be controlled remotely.";
    case "ALREADY_PAUSED":
      return "Spotify is already paused.";
    case "ALREADY_PLAYING":
    case "NOT_PAUSED":
      return "Spotify is already playing.";
    default:
      return "Spotify doesn't allow that command for what's playing right now.";
  }
}

/** `Retry-After` is seconds (or an HTTP date); default to a conservative wait. */
export function parseRetryAfter(value: string | null): number {
  if (!value) return 5;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 5 : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function formatWait(seconds: number): string {
  return seconds < 90 ? `${Math.max(1, seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}
