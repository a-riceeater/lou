import type { SearchType, SpotifyAlbum, SpotifyArtist, SpotifyDevice, SpotifyPlayable, SpotifyPlaybackState, SpotifyPlaylist, SpotifySearchResponse, SpotifyTrack } from "./types";

/**
 * Pure helpers that turn Spotify responses into compact, model-friendly shapes
 * and resolve loose human input ("my bedroom speaker", "some Laufey", "1:32")
 * into concrete Spotify targets. No I/O here, so it is exhaustively testable.
 */

// ---- Normalized shapes ---------------------------------------------------------

export interface DeviceSummary {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
  supportsVolume: boolean;
}

export interface ItemSummary {
  type: "track" | "episode";
  name: string;
  artists: string[];
  album: string | null;
  uri: string;
  durationMs: number;
  imageUrl: string | null;
  url: string | null;
}

export interface PlaybackSummary {
  isPlaying: boolean;
  item: ItemSummary | null;
  progressMs: number;
  device: DeviceSummary | null;
  shuffle: boolean;
  repeat: "off" | "track" | "context";
  context: { type: string; uri: string } | null;
}

export function summarizeDevice(d: SpotifyDevice): DeviceSummary | null {
  // Devices without an ID cannot be targeted by any command.
  if (!d.id) return null;
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    isActive: d.is_active,
    isRestricted: d.is_restricted,
    volumePercent: d.volume_percent ?? null,
    // Older payloads omit supports_volume; a reported volume implies support.
    supportsVolume: d.supports_volume ?? d.volume_percent != null,
  };
}

export function summarizeDevices(devices: SpotifyDevice[]): DeviceSummary[] {
  return devices.map(summarizeDevice).filter((d): d is DeviceSummary => d !== null);
}

export function summarizeItem(item: SpotifyPlayable | null | undefined): ItemSummary | null {
  if (!item) return null;
  if (item.type === "track") {
    return {
      type: "track",
      name: item.name,
      artists: item.artists.map((a) => a.name),
      album: item.album?.name ?? null,
      uri: item.uri,
      durationMs: item.duration_ms,
      imageUrl: pickImage(item.album?.images ?? []),
      url: item.external_urls?.spotify ?? null,
    };
  }
  return {
    type: "episode",
    name: item.name,
    artists: item.show?.name ? [item.show.name] : [],
    album: item.show?.name ?? null,
    uri: item.uri,
    durationMs: item.duration_ms,
    imageUrl: pickImage(item.images.length ? item.images : (item.show?.images ?? [])),
    url: item.external_urls?.spotify ?? null,
  };
}

export function summarizePlayback(state: SpotifyPlaybackState | null): PlaybackSummary {
  if (!state) return { isPlaying: false, item: null, progressMs: 0, device: null, shuffle: false, repeat: "off", context: null };
  const item = summarizeItem(state.item);
  return {
    isPlaying: state.is_playing,
    item,
    progressMs: clamp(state.progress_ms ?? 0, 0, item?.durationMs ?? Number.MAX_SAFE_INTEGER),
    device: state.device ? summarizeDevice(state.device) : null,
    shuffle: state.shuffle_state,
    repeat: state.repeat_state,
    context: state.context ?? null,
  };
}

/** Smallest image that is still at least 64px, for compact UI. */
function pickImage(images: Array<{ url: string; width?: number | null }>): string | null {
  if (!images.length) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 64) ?? sorted.at(-1))!.url;
}

/** A compact description the model can repeat to the user. */
export function describeItem(item: Pick<ItemSummary, "name" | "artists"> | null): string | null {
  if (!item) return null;
  return item.artists.length ? `${item.name} by ${item.artists.join(", ")}` : item.name;
}

// ---- Time --------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Parses "1:32", "01:02:03", "92", "92s", "1m32s", "1 min 32 sec", "2 minutes"
 * into milliseconds. Returns null for anything else.
 */
export function parseTimestamp(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const colon = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (colon) {
    const [a, b, c] = [Number(colon[1]), Number(colon[2]), colon[3] === undefined ? undefined : Number(colon[3])];
    if (c === undefined) return b < 60 ? (a * 60 + b) * 1000 : null;
    return b < 60 && c < 60 ? (a * 3600 + b * 60 + c) * 1000 : null;
  }
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const units = /(\d+(?:\.\d+)?)\s*(hours?|hrs|hr|h|minutes?|mins|min|m|seconds?|secs|sec|s)(?![a-z])/g;
  let total = 0;
  let matched = "";
  for (const m of text.matchAll(units)) {
    const value = Number(m[1]);
    const unit = m[2]![0];
    total += unit === "h" ? value * 3600 : unit === "m" ? value * 60 : value;
    matched += m[0];
  }
  // Every non-space character must belong to a recognised "<number><unit>" part.
  if (!matched || text.replace(/\s|and|,/g, "").length !== matched.replace(/\s/g, "").length) return null;
  return Math.round(total * 1000);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- Text similarity -----------------------------------------------------------------

export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Drops version noise: "(feat. X)", "- Remastered 2011", "[Live]". */
export function cleanTitle(s: string): string {
  return normalizeText(s.replace(/\s[-–—]\s.*$/, "").replace(/[([].*?[)\]]/g, " "));
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of character bigrams, 0..1, on normalized text. */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let overlap = 0;
  let size = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) ?? 0);
    size += n;
  }
  for (const n of B.values()) size += n;
  return (2 * overlap) / size;
}

// ---- Devices ------------------------------------------------------------------------

const DEVICE_STOPWORDS = new Set(["my", "the", "a", "on", "to", "spotify", "device", "app", "please", "this", "that", "our"]);

/** Generic words people use for a device type. */
const TYPE_ALIASES: Record<string, readonly string[]> = {
  computer: ["Computer"],
  pc: ["Computer"],
  laptop: ["Computer"],
  desktop: ["Computer"],
  mac: ["Computer"],
  macbook: ["Computer"],
  browser: ["Computer"],
  phone: ["Smartphone"],
  mobile: ["Smartphone"],
  iphone: ["Smartphone"],
  android: ["Smartphone"],
  cell: ["Smartphone"],
  tablet: ["Tablet"],
  ipad: ["Tablet"],
  speaker: ["Speaker", "CastAudio", "AVR", "AudioDongle"],
  speakers: ["Speaker", "CastAudio", "AVR", "AudioDongle"],
  tv: ["TV", "CastVideo", "STB"],
  television: ["TV", "CastVideo", "STB"],
  chromecast: ["CastVideo", "CastAudio"],
  console: ["GameConsole"],
  xbox: ["GameConsole"],
  playstation: ["GameConsole"],
  ps5: ["GameConsole"],
  car: ["Automobile"],
  receiver: ["AVR"],
  stereo: ["AVR", "Speaker"],
};

export type DeviceMatch = { kind: "match"; device: DeviceSummary } | { kind: "ambiguous"; candidates: DeviceSummary[] } | { kind: "none" };

function deviceTokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t && !DEVICE_STOPWORDS.has(t));
}

/**
 * Resolves a spoken device reference to exactly one device, or reports the
 * candidates so the assistant can ask. Order: exact ID, exact name, all words
 * of the request in the name, then the device type ("my phone").
 */
export function matchDevice(devices: DeviceSummary[], ref: { id?: string; name?: string }): DeviceMatch {
  if (ref.id) {
    const byId = devices.find((d) => d.id === ref.id);
    if (byId) return { kind: "match", device: byId };
    if (!ref.name) return { kind: "none" };
  }
  const name = ref.name ?? "";
  const exact = devices.filter((d) => normalizeText(d.name) === normalizeText(name));
  if (exact.length) return pick(exact);

  const tokens = deviceTokens(name);
  if (!tokens.length) return { kind: "none" };
  const nameMatches = devices.filter((d) => {
    const nameTokens = deviceTokens(d.name);
    return tokens.every((t) => nameTokens.some((n) => n === t || (t.length >= 3 && n.startsWith(t))));
  });
  if (nameMatches.length) return pick(nameMatches);

  // "my phone", "the living room tv": type words, plus any remaining words must appear in the name.
  const types = new Set(tokens.flatMap((t) => TYPE_ALIASES[t] ?? []));
  if (types.size) {
    const rest = tokens.filter((t) => !TYPE_ALIASES[t]);
    const byType = devices.filter((d) => types.has(d.type) && rest.every((t) => deviceTokens(d.name).some((n) => n.startsWith(t))));
    if (byType.length) return pick(byType);
  }

  const fuzzy = devices.map((d) => ({ d, s: similarity(d.name, tokens.join(" ")) })).filter((x) => x.s >= 0.6);
  if (fuzzy.length) {
    const best = Math.max(...fuzzy.map((x) => x.s));
    return pick(fuzzy.filter((x) => best - x.s < 0.1).map((x) => x.d));
  }
  return { kind: "none" };
}

function pick(candidates: DeviceSummary[]): DeviceMatch {
  if (candidates.length === 1) return { kind: "match", device: candidates[0]! };
  // Prefer controllable devices when only one of several matches is.
  const usable = candidates.filter((d) => !d.isRestricted);
  if (usable.length === 1) return { kind: "match", device: usable[0]! };
  return { kind: "ambiguous", candidates };
}

export function deviceLabel(d: DeviceSummary): string {
  return `${d.name} (${d.type}${d.isActive ? ", active" : ""}${d.isRestricted ? ", can't be controlled" : ""})`;
}

// ---- Playable resolution ------------------------------------------------------------

export type ResolvedType = "track" | "album" | "artist" | "playlist" | "episode" | "collection";

export interface ResolvedItem {
  type: ResolvedType;
  uri: string;
  name: string;
  /** Artist(s), owner or show — for the confirmation sentence. */
  by: string | null;
}

export interface PlayQuery {
  /** Text to search for, with cue words removed. */
  text: string;
  /** Type implied by the wording ("the album …", "some …"), if any. */
  type?: Exclude<SearchType, "episode">;
  /** Artist from "X by Y". */
  artist?: string;
  /** Refers to the user's own library ("my …", Discover Weekly, Daily Mix). */
  mine: boolean;
  /** "my liked songs" → the Liked Songs collection. */
  likedSongs: boolean;
}

const PERSONAL_PLAYLISTS = /\b(discover weekly|release radar|daily mix|daylist|on repeat|repeat rewind|time capsule|your top songs|blend)\b/;

export function parsePlayQuery(raw: string, type?: Exclude<SearchType, "episode">): PlayQuery {
  let text = raw.trim().replace(/^play\s+/i, "").replace(/\s+(on|in|from)\s+spotify$/i, "").trim();
  let lower = normalizeText(text);
  if (/^(my )?(liked|saved|favou?rite) (songs|tracks|music)$|^my (library|likes)$/.test(lower)) {
    return { text, type: "playlist", mine: true, likedSongs: true };
  }
  let mine = false;
  const strip = (re: RegExp) => {
    const m = re.exec(text);
    if (!m) return false;
    text = text.replace(re, "").trim();
    lower = normalizeText(text);
    return true;
  };
  if (strip(/^my\s+/i)) mine = true;
  let implied: PlayQuery["type"] = type;
  if (!implied) {
    if (strip(/^(the\s+)?(song|track)\s+/i)) implied = "track";
    else if (strip(/^(the\s+)?album\s+/i) || strip(/\s+album$/i)) implied = "album";
    else if (strip(/^(the\s+)?playlist\s+/i) || strip(/\s+playlist$/i)) implied = "playlist";
    else if (strip(/^(some|something by|anything by|songs by|music by|tracks by|stuff by)\s+/i) || (!mine && strip(/\s+(songs|music|tracks)$/i))) implied = "artist";
  } else {
    strip(/^(the\s+)?(song|track|album|playlist)\s+/i);
  }
  if (PERSONAL_PLAYLISTS.test(lower)) {
    mine = true;
    implied ??= "playlist";
  }
  let artist: string | undefined;
  const by = /^(.+?)\s+by\s+(.+)$/i.exec(text);
  if (by && implied !== "artist" && implied !== "playlist") {
    text = by[1]!.trim();
    artist = by[2]!.trim();
  }
  return { text, type: implied, artist, mine, likedSongs: false };
}

interface Candidate {
  item: ResolvedItem;
  score: number;
}

const TYPE_BONUS: Record<string, number> = { artist: 0.06, track: 0.04, album: 0.02, playlist: 0 };

/**
 * Picks the most plausible item across search results. Exact (cleaned) name
 * matches dominate; among equals, an artist beats a track beats an album beats
 * a playlist, so "Billie Eilish" plays the artist and "Hit Me Hard and Soft"
 * the album. Spotify's own relevance order breaks remaining ties.
 */
export function rankResults(query: PlayQuery, results: SpotifySearchResponse, libraryPlaylists: SpotifyPlaylist[] = []): ResolvedItem | null {
  const candidates: Candidate[] = [];
  const text = query.text;
  const artistHint = query.artist;
  const consider = (type: string) => !query.type || query.type === type;
  const titleScore = (name: string, artists: string[]) => {
    // An exact title beats the same title with version noise ("- Remix", "(Live)").
    const exact = normalizeText(name) === normalizeText(text) ? 0.15 : cleanTitle(name) === normalizeText(text) ? 0.08 : 0;
    const titleSim = Math.max(similarity(cleanTitle(name), text), similarity(`${cleanTitle(name)} ${artists.join(" ")}`, text) * 0.95);
    if (!artistHint) return titleSim + exact;
    const artistSim = Math.max(0, ...artists.map((a) => similarity(a, artistHint)));
    return titleSim * 0.65 + artistSim * 0.35 + exact;
  };

  if (consider("track")) {
    (results.tracks?.items ?? []).forEach((t: SpotifyTrack, i) => {
      if (t.is_playable === false) return;
      const artists = t.artists.map((a) => a.name);
      candidates.push({ item: { type: "track", uri: t.uri, name: t.name, by: artists.join(", ") || null }, score: titleScore(t.name, artists) + TYPE_BONUS.track! - i * 0.02 });
    });
  }
  if (consider("album")) {
    (results.albums?.items ?? []).forEach((a: SpotifyAlbum, i) => {
      const artists = a.artists.map((x) => x.name);
      candidates.push({ item: { type: "album", uri: a.uri, name: a.name, by: artists.join(", ") || null }, score: titleScore(a.name, artists) + TYPE_BONUS.album! - i * 0.02 });
    });
  }
  if (consider("artist") && !artistHint) {
    (results.artists?.items ?? []).forEach((a: SpotifyArtist, i) => {
      const exact = normalizeText(a.name) === normalizeText(text) ? 0.15 : 0;
      candidates.push({ item: { type: "artist", uri: a.uri, name: a.name, by: null }, score: similarity(a.name, text) + exact + TYPE_BONUS.artist! - i * 0.02 });
    });
  }
  if (consider("playlist") && !artistHint) {
    const seen = new Set<string>();
    const addPlaylist = (p: SpotifyPlaylist, i: number, owned: boolean) => {
      if (seen.has(p.uri)) return;
      seen.add(p.uri);
      const exact = normalizeText(p.name) === normalizeText(text) ? 0.15 : 0;
      const ownership = owned ? (query.mine ? 0.2 : 0.05) : 0;
      candidates.push({ item: { type: "playlist", uri: p.uri, name: p.name, by: p.owner?.display_name ?? null }, score: similarity(p.name, text) + exact + ownership + TYPE_BONUS.playlist! - i * 0.02 });
    };
    libraryPlaylists.forEach((p, i) => addPlaylist(p, Math.min(i, 5), true));
    (results.playlists?.items ?? []).forEach((p, i) => addPlaylist(p, i, false));
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.item;
}

/** Search types to request for a parsed query (Spotify allows several per call). */
export function searchTypesFor(query: PlayQuery): Array<Exclude<SearchType, "episode">> {
  if (query.type) return [query.type];
  if (query.artist) return ["track", "album"];
  return ["track", "artist", "album", "playlist"];
}

/** Spotify search syntax for a parsed query; "X by Y" narrows by artist. */
export function searchQueryFor(query: PlayQuery): string {
  return query.artist ? `${query.text} artist:${query.artist}` : query.text;
}

const URI = /^spotify:(track|album|artist|playlist|episode|show):[A-Za-z0-9]{22}$/;
const COLLECTION_URI = /^spotify:user:[^:\s]+:collection$/;

export function uriType(uri: string): ResolvedType | "show" | null {
  if (COLLECTION_URI.test(uri)) return "collection";
  const m = URI.exec(uri);
  return m ? (m[1] as ResolvedType | "show") : null;
}

/** open.spotify.com URL for a URI, for attribution links. */
export function webUrl(uri: string): string | null {
  const m = URI.exec(uri);
  return m ? `https://open.spotify.com/${m[1]}/${uri.split(":")[2]}` : null;
}
