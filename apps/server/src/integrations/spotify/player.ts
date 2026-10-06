import type { SpotifyPlayerView } from "@lou/protocol";
import { LouError } from "@lou/shared";
import type { IntegrationManager } from "../manager";
import type { SpotifyApi } from "./client";
import type { SpotifyConnector } from "./connector";
import { isSpotifyError, RECONNECT_MESSAGE, SpotifyError } from "./errors";
import {
  clamp,
  deviceLabel,
  formatDuration,
  matchDevice,
  normalizeText,
  parsePlayQuery,
  parseTimestamp,
  rankResults,
  searchQueryFor,
  searchTypesFor,
  summarizeDevices,
  summarizeItem,
  summarizePlayback,
  uriType,
  webUrl,
  type DeviceSummary,
  type PlaybackSummary,
  type ResolvedItem,
} from "./resolve";
import type { RepeatState, SearchType, SpotifyPlaylist } from "./types";

export interface DeviceRef {
  deviceId?: string;
  deviceName?: string;
}

interface Session {
  accountId: string;
  spotifyUserId: string;
  api: SpotifyApi;
  signal?: AbortSignal;
}

export type PlayableType = "track" | "album" | "artist" | "playlist";

const STATE_TTL_MS = 3_000;
const LIBRARY_TTL_MS = 5 * 60_000;
const LIBRARY_PAGES = 4;

/**
 * Lou's Spotify capability provider: high-level, intention-shaped operations
 * built on {@link SpotifyApi}. It resolves names to Spotify IDs (the model never
 * invents them), picks devices only when the choice is unambiguous, sequences
 * dependent player commands one at a time, and returns compact summaries.
 */
export class SpotifyPlayer {
  private readonly stateCache = new Map<string, { at: number; value: PlaybackSummary }>();
  private readonly stateInflight = new Map<string, Promise<PlaybackSummary>>();
  private readonly libraryCache = new Map<string, { at: number; items: SpotifyPlaylist[] }>();

  constructor(
    private readonly connector: SpotifyConnector,
    private readonly integrations: IntegrationManager,
  ) {}

  // ---- State ----------------------------------------------------------------------

  /** Current playback, optionally served from a short cache (UI polling); tools always read fresh. */
  async playback(userId: string, options: { maxAgeMs?: number; signal?: AbortSignal } = {}): Promise<PlaybackSummary> {
    return this.run(userId, options.signal, (s) => this.readState(s, options.maxAgeMs ?? 0));
  }

  async playerView(userId: string): Promise<SpotifyPlayerView> {
    const state = await this.playback(userId, { maxAgeMs: STATE_TTL_MS });
    const at = this.stateCache.get(this.connector.requireAccount(userId).id)?.at ?? Date.now();
    return {
      active: !!state.device,
      isPlaying: state.isPlaying,
      item: state.item
        ? { type: state.item.type, name: state.item.name, artists: state.item.artists, album: state.item.album, imageUrl: state.item.imageUrl, url: state.item.url ?? webUrl(state.item.uri), durationMs: state.item.durationMs }
        : null,
      progressMs: state.progressMs,
      fetchedAt: new Date(at).toISOString(),
      device: state.device,
      shuffle: state.shuffle,
      repeat: state.repeat,
    };
  }

  async devices(userId: string, signal?: AbortSignal): Promise<DeviceSummary[]> {
    return this.run(userId, signal, async (s) => summarizeDevices(await s.api.devices(s.signal)));
  }

  async queue(userId: string, limit: number, signal?: AbortSignal) {
    return this.run(userId, signal, async (s) => {
      const q = await s.api.queue(s.signal);
      const current = summarizeItem(q.currently_playing);
      return {
        currentlyPlaying: current ? { name: current.name, by: current.artists.join(", ") || null, uri: current.uri } : null,
        upNext: q.queue.slice(0, limit).map((i) => {
          const item = summarizeItem(i)!;
          return { type: item.type, name: item.name, by: item.artists.join(", ") || null, uri: item.uri };
        }),
      };
    });
  }

  async search(userId: string, query: string, types: readonly SearchType[], limit: number, signal?: AbortSignal) {
    return this.run(userId, signal, async (s) => {
      const r = await s.api.search(query, types, limit, s.signal);
      const library = types.includes("playlist") && parsePlayQuery(query).mine ? await this.libraryPlaylists(s) : [];
      const own = library.filter((p) => normalizeText(p.name).includes(normalizeText(query.replace(/^my\s+/i, "")))).slice(0, 3);
      return {
        ...(r.tracks ? { tracks: r.tracks.items.map((t) => ({ name: t.name, by: t.artists.map((a) => a.name).join(", "), album: t.album?.name ?? null, duration: formatDuration(t.duration_ms), uri: t.uri })) } : {}),
        ...(r.artists ? { artists: r.artists.items.map((a) => ({ name: a.name, uri: a.uri })) } : {}),
        ...(r.albums ? { albums: r.albums.items.map((a) => ({ name: a.name, by: a.artists.map((x) => x.name).join(", "), year: a.release_date?.slice(0, 4) ?? null, uri: a.uri })) } : {}),
        ...(r.playlists || own.length ? { playlists: [...own, ...(r.playlists?.items ?? [])].map((p) => ({ name: p.name, owner: p.owner?.display_name ?? null, uri: p.uri, yours: own.includes(p) })) } : {}),
        ...(r.episodes ? { episodes: r.episodes.items.map((e) => ({ name: e.name, show: e.show?.name ?? null, uri: e.uri })) } : {}),
      };
    });
  }

  // ---- Playback commands ---------------------------------------------------------

  /** Resume, or play a named/URI'd item, optionally on a specific device (one transfer+play request). */
  async play(userId: string, input: { query?: string; uri?: string; type?: PlayableType } & DeviceRef, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      let device = await this.targetDevice(s, input);
      let item: ResolvedItem | null = null;
      if (input.uri) {
        const type = uriType(input.uri);
        if (!type || type === "show") throw new SpotifyError("SPOTIFY_INVALID_REQUEST", "That isn't a playable Spotify URI. Use a URI returned by spotify.search, or pass a query instead.");
        item = { type, uri: input.uri, name: input.uri, by: null };
      } else if (input.query) {
        item = await this.resolvePlayable(s, input.query, input.type);
        if (!item) throw new SpotifyError("SPOTIFY_NOTHING_FOUND", `Nothing on Spotify matched "${input.query}".`);
      }
      const body = !item ? {} : item.type === "track" || item.type === "episode" ? { uris: [item.uri] } : { contextUri: item.uri };
      try {
        await s.api.play({ deviceId: device?.id, ...body }, s.signal);
      } catch (err) {
        if (isSpotifyError(err, "SPOTIFY_RESTRICTED") && !item && err.details?.reason === "ALREADY_PLAYING") return { playing: null, resumed: true, device: device?.name ?? null };
        if (device || !isSpotifyError(err, "SPOTIFY_NO_ACTIVE_DEVICE")) throw err;
        // Nothing is active: use the only controllable device, otherwise ask.
        device = await this.soleUsableDevice(s);
        await s.api.play({ deviceId: device.id, ...body }, s.signal);
      }
      return {
        playing: item ? { type: item.type === "collection" ? "playlist" : item.type, name: item.name, by: item.by, uri: item.uri } : null,
        resumed: !item,
        device: device?.name ?? null,
      };
    });
  }

  async pause(userId: string, device: DeviceRef = {}, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      const target = await this.targetDevice(s, device);
      try {
        await s.api.pause(target?.id, s.signal);
        return { paused: true };
      } catch (err) {
        if (isSpotifyError(err, "SPOTIFY_NO_ACTIVE_DEVICE")) return { paused: true, note: "Nothing was playing." };
        if (isSpotifyError(err, "SPOTIFY_RESTRICTED") && err.details?.reason === "ALREADY_PAUSED") return { paused: true, note: "Already paused." };
        throw err;
      }
    });
  }

  async next(userId: string, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      await this.withActivePlayer(s, () => s.api.next(undefined, s.signal));
      return { skipped: true };
    });
  }

  async previous(userId: string, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      await this.withActivePlayer(s, () => s.api.previous(undefined, s.signal));
      return { wentBack: true };
    });
  }

  /** Absolute ("1:32", ms), relative (±seconds) or restart. Reads the track length so seeks stay in range. */
  async seek(userId: string, input: { position?: string; positionMs?: number; offsetSeconds?: number; restart?: boolean }, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      const state = await this.readState(s, 0);
      if (!state.device || !state.item) throw await this.noActiveDevice(s, "Nothing is playing on Spotify right now, so there's nothing to seek.");
      let target: number;
      if (input.restart) target = 0;
      else if (input.positionMs !== undefined) target = input.positionMs;
      else if (input.position !== undefined) {
        const parsed = parseTimestamp(input.position);
        if (parsed === null) throw new SpotifyError("SPOTIFY_INVALID_REQUEST", `"${input.position}" isn't a time. Use m:ss, like 1:32.`);
        target = parsed;
      } else if (input.offsetSeconds !== undefined) target = state.progressMs + input.offsetSeconds * 1000;
      else throw new SpotifyError("SPOTIFY_INVALID_REQUEST", "Give a position, an offset in seconds, or restart.");
      if (target >= state.item.durationMs && input.offsetSeconds === undefined) {
        throw new SpotifyError("SPOTIFY_INVALID_REQUEST", `${formatDuration(target)} is past the end of this ${state.item.type} (${formatDuration(state.item.durationMs)}).`);
      }
      target = clamp(target, 0, Math.max(0, state.item.durationMs - 1000));
      await s.api.seek(target, undefined, s.signal);
      return { position: formatDuration(target), positionMs: target, duration: formatDuration(state.item.durationMs) };
    });
  }

  /** Absolute 0–100 or a relative change; checks the device allows remote volume first. */
  async setVolume(userId: string, input: { volumePercent?: number; change?: number } & DeviceRef, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      let device = await this.targetDevice(s, input);
      if (!device) {
        device = (await this.readState(s, 0)).device ?? undefined;
        if (!device) throw await this.noActiveDevice(s);
      }
      if (!device.supportsVolume) throw new SpotifyError("SPOTIFY_RESTRICTED", `${device.name} doesn't allow its volume to be changed remotely. Use the device's own volume control.`);
      const current = device.volumePercent;
      let target: number;
      if (input.volumePercent !== undefined) target = input.volumePercent;
      else if (input.change !== undefined) target = (current ?? 50) + input.change;
      else throw new SpotifyError("SPOTIFY_INVALID_REQUEST", "Give a volume (0–100) or a change.");
      target = Math.round(clamp(target, 0, 100));
      if (target !== current) await s.api.setVolume(target, input.deviceId || input.deviceName ? device.id : undefined, s.signal);
      return { volumePercent: target, previousPercent: current, device: device.name };
    });
  }

  async setShuffle(userId: string, state: boolean, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      await this.withActivePlayer(s, () => s.api.setShuffle(state, undefined, s.signal));
      return { shuffle: state };
    });
  }

  async setRepeat(userId: string, mode: RepeatState, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      await this.withActivePlayer(s, () => s.api.setRepeat(mode, undefined, s.signal));
      return { repeat: mode };
    });
  }

  async addToQueue(userId: string, input: { query?: string; uri?: string; type?: "track" | "episode" }, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      let item: ResolvedItem | null;
      if (input.uri) {
        const type = uriType(input.uri);
        if (type !== "track" && type !== "episode") throw new SpotifyError("SPOTIFY_INVALID_REQUEST", "Only songs and podcast episodes can be added to the queue.");
        item = { type, uri: input.uri, name: input.uri, by: null };
      } else if (input.query) {
        item = input.type === "episode" ? await this.resolveEpisode(s, input.query) : await this.resolvePlayable(s, input.query, "track");
        if (!item) throw new SpotifyError("SPOTIFY_NOTHING_FOUND", `Nothing on Spotify matched "${input.query}".`);
      } else {
        throw new SpotifyError("SPOTIFY_INVALID_REQUEST", "Say what to add to the queue.");
      }
      const uri = item.uri;
      await this.withActivePlayer(s, () => s.api.addToQueue(uri, undefined, s.signal));
      return { queued: { type: item.type, name: item.name, by: item.by, uri } };
    });
  }

  async transfer(userId: string, input: DeviceRef & { play?: boolean }, signal?: AbortSignal) {
    return this.mutate(userId, signal, async (s) => {
      if (!input.deviceId && !input.deviceName) throw new SpotifyError("SPOTIFY_INVALID_REQUEST", "Say which device to move Spotify to.");
      const device = (await this.targetDevice(s, input))!;
      if (device.isActive && input.play === undefined) return { transferred: false, device: device.name, note: "Spotify is already playing there." };
      await s.api.transfer(device.id, input.play, s.signal);
      return { transferred: true, device: device.name };
    });
  }

  // ---- Resolution -----------------------------------------------------------------

  /** Search → most plausible item. Names and IDs always come from Spotify's responses. */
  async resolvePlayable(s: Session, raw: string, type?: PlayableType): Promise<ResolvedItem | null> {
    const query = parsePlayQuery(raw, type);
    if (query.likedSongs) return { type: "collection", uri: `spotify:user:${s.spotifyUserId}:collection`, name: "Liked Songs", by: null };
    const library = query.mine || query.type === "playlist" ? await this.libraryPlaylists(s) : [];
    const own = library.find((p) => normalizeText(p.name) === normalizeText(query.text));
    if (own && (query.mine || query.type === "playlist")) return { type: "playlist", uri: own.uri, name: own.name, by: own.owner?.display_name ?? null };

    const results = await s.api.search(searchQueryFor(query), searchTypesFor(query), 5, s.signal);
    const best = rankResults(query, results, library);
    if (best || type) return best;
    // Cue words ("some …", "… by …") can mislead; retry once as a plain search.
    if (query.type || query.artist) {
      const plain = { ...query, text: raw.trim(), type: undefined, artist: undefined };
      return rankResults(plain, await s.api.search(plain.text, searchTypesFor(plain), 5, s.signal), library);
    }
    return null;
  }

  private async resolveEpisode(s: Session, raw: string): Promise<ResolvedItem | null> {
    const episode = (await s.api.search(raw, ["episode"], 5, s.signal)).episodes?.items[0];
    return episode ? { type: "episode", uri: episode.uri, name: episode.name, by: episode.show?.name ?? null } : null;
  }

  /** The user's own and followed playlists (cached briefly). Needs playlist-read-private for private ones. */
  private async libraryPlaylists(s: Session): Promise<SpotifyPlaylist[]> {
    const cached = this.libraryCache.get(s.accountId);
    if (cached && Date.now() - cached.at < LIBRARY_TTL_MS) return cached.items;
    const items: SpotifyPlaylist[] = [];
    try {
      for (let page = 0; page < LIBRARY_PAGES; page++) {
        const res = await s.api.myPlaylists(50, page * 50, s.signal);
        items.push(...res.items);
        if (!res.next) break;
      }
    } catch (err) {
      // Connections made before the playlist scope was added still work for public catalog search.
      if (!isSpotifyError(err, "SPOTIFY_INSUFFICIENT_SCOPE")) throw err;
    }
    this.libraryCache.set(s.accountId, { at: Date.now(), items });
    return items;
  }

  // ---- Devices --------------------------------------------------------------------

  /** Resolves an explicit device reference against a fresh device list (IDs are not stable). */
  private async targetDevice(s: Session, ref: DeviceRef): Promise<DeviceSummary | undefined> {
    if (!ref.deviceId && !ref.deviceName) return undefined;
    const devices = summarizeDevices(await s.api.devices(s.signal));
    const label = ref.deviceName ?? ref.deviceId!;
    if (!devices.length) throw this.noDevicesError();
    const match = matchDevice(devices, { id: ref.deviceId, name: ref.deviceName });
    if (match.kind === "none") {
      throw new SpotifyError("SPOTIFY_DEVICE_NOT_FOUND", `No Spotify device matches "${label}". Available devices: ${devices.map(deviceLabel).join("; ")}. Ask the user which one they mean.`, {
        details: { devices },
      });
    }
    if (match.kind === "ambiguous") {
      throw new SpotifyError("SPOTIFY_DEVICE_AMBIGUOUS", `Several Spotify devices match "${label}": ${match.candidates.map(deviceLabel).join("; ")}. Ask the user which one they mean.`, {
        details: { devices: match.candidates },
      });
    }
    if (match.device.isRestricted) {
      throw new SpotifyError("SPOTIFY_RESTRICTED", `${match.device.name} can't be controlled remotely through Spotify Connect. Use the device itself.`, { details: { device: match.device } });
    }
    return match.device;
  }

  private async soleUsableDevice(s: Session): Promise<DeviceSummary> {
    const devices = summarizeDevices(await s.api.devices(s.signal));
    const usable = devices.filter((d) => !d.isRestricted);
    if (usable.length === 1) return usable[0]!;
    throw this.noActiveDeviceError(devices);
  }

  private async withActivePlayer(s: Session, command: () => Promise<void>): Promise<void> {
    try {
      await command();
    } catch (err) {
      if (isSpotifyError(err, "SPOTIFY_NO_ACTIVE_DEVICE")) throw await this.noActiveDevice(s);
      throw err;
    }
  }

  private async noActiveDevice(s: Session, message?: string): Promise<SpotifyError> {
    return this.noActiveDeviceError(summarizeDevices(await s.api.devices(s.signal)), message);
  }

  private noDevicesError(): SpotifyError {
    return new SpotifyError("SPOTIFY_NO_ACTIVE_DEVICE", "No Spotify device is available. Open the Spotify app on a phone, computer or speaker (it has to be running), then try again.", { details: { devices: [] } });
  }

  private noActiveDeviceError(devices: DeviceSummary[], message?: string): SpotifyError {
    if (!devices.length) return this.noDevicesError();
    const usable = devices.filter((d) => !d.isRestricted);
    if (!usable.length) {
      return new SpotifyError("SPOTIFY_NO_ACTIVE_DEVICE", `Spotify isn't playing anywhere, and the available devices can't be controlled remotely: ${devices.map(deviceLabel).join("; ")}.`, { details: { devices } });
    }
    return new SpotifyError(
      "SPOTIFY_NO_ACTIVE_DEVICE",
      `${message ?? "Spotify isn't playing on any device right now."} Available devices: ${usable.map(deviceLabel).join("; ")}. Ask the user which device to use, then pass its name as deviceName.`,
      { details: { devices } },
    );
  }

  // ---- Plumbing ----------------------------------------------------------------------

  /** maxAgeMs > 0 allows a cached or in-flight read, so several polling clients cost one Spotify call. */
  private async readState(s: Session, maxAgeMs: number): Promise<PlaybackSummary> {
    const cached = this.stateCache.get(s.accountId);
    if (maxAgeMs > 0) {
      if (cached && Date.now() - cached.at <= maxAgeMs) return cached.value;
      const inflight = this.stateInflight.get(s.accountId);
      if (inflight) return inflight;
    }
    const read = s.api
      .playbackState(s.signal)
      .then(summarizePlayback)
      .then((value) => {
        this.stateCache.set(s.accountId, { at: Date.now(), value });
        return value;
      });
    if (maxAgeMs > 0) {
      this.stateInflight.set(s.accountId, read);
      void read.finally(() => this.stateInflight.delete(s.accountId)).catch(() => undefined);
    }
    return read;
  }

  private async mutate<T>(userId: string, signal: AbortSignal | undefined, fn: (s: Session) => Promise<T>): Promise<T> {
    try {
      return await this.run(userId, signal, fn);
    } finally {
      // Whatever happened, the next read must come from Spotify.
      const account = this.connector.accounts(userId)[0];
      if (account) this.stateCache.delete(account.id);
    }
  }

  /** Opens a session for the user's account and keeps its connection status honest. */
  private async run<T>(userId: string, signal: AbortSignal | undefined, fn: (s: Session) => Promise<T>): Promise<T> {
    const account = this.connector.requireAccount(userId);
    const session: Session = { accountId: account.id, spotifyUserId: account.externalId ?? "", api: this.connector.api(account.id), signal };
    try {
      const result = await fn(session);
      if (account.status === "error") this.integrations.setStatus(account.id, "connected", null);
      return result;
    } catch (err) {
      if (err instanceof LouError && !(err instanceof SpotifyError) && err.code === "AUTH_REQUIRED") {
        this.integrations.setStatus(account.id, "needs_reauth", err.message);
        throw new SpotifyError("SPOTIFY_AUTH_EXPIRED", RECONNECT_MESSAGE, { cause: err });
      }
      if (isSpotifyError(err, "SPOTIFY_AUTH_EXPIRED") || isSpotifyError(err, "SPOTIFY_INSUFFICIENT_SCOPE")) {
        this.integrations.setStatus(account.id, "needs_reauth", err.message);
        if (err.spotifyCode === "SPOTIFY_AUTH_EXPIRED" && err.message !== RECONNECT_MESSAGE) throw new SpotifyError("SPOTIFY_AUTH_EXPIRED", RECONNECT_MESSAGE, { cause: err, details: err.details });
      } else if (isSpotifyError(err, "SPOTIFY_UNAVAILABLE")) {
        this.integrations.setStatus(account.id, "error", err.message);
      }
      throw err;
    }
  }
}

