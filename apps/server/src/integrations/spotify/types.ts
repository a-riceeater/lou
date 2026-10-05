import { z } from "zod";

/**
 * The slices of Spotify Web API responses Lou actually uses. Responses are
 * validated against these schemas at the client boundary, so the rest of the
 * server never touches untyped JSON and malformed responses fail loudly.
 * Spotify returns `null` liberally (ads, local files, private sessions), hence
 * the generous nullability.
 */

const Image = z.object({ url: z.string(), height: z.number().nullish(), width: z.number().nullish() });
const Images = z.array(Image).nullish().transform((v) => v ?? []);
const ExternalUrls = z.object({ spotify: z.string().optional() }).partial().nullish();

export const ArtistSchema = z.object({
  id: z.string().nullish(),
  name: z.string(),
  uri: z.string(),
  images: Images.optional(),
  external_urls: ExternalUrls,
});
export type SpotifyArtist = z.infer<typeof ArtistSchema>;

export const AlbumSchema = z.object({
  id: z.string().nullish(),
  name: z.string(),
  uri: z.string(),
  album_type: z.string().nullish(),
  artists: z.array(ArtistSchema).nullish().transform((v) => v ?? []),
  images: Images,
  release_date: z.string().nullish(),
  external_urls: ExternalUrls,
});
export type SpotifyAlbum = z.infer<typeof AlbumSchema>;

export const TrackSchema = z.object({
  type: z.literal("track"),
  id: z.string().nullish(),
  name: z.string(),
  uri: z.string(),
  duration_ms: z.number(),
  artists: z.array(ArtistSchema),
  album: AlbumSchema.nullish(),
  is_local: z.boolean().nullish(),
  is_playable: z.boolean().nullish(),
  external_urls: ExternalUrls,
});
export type SpotifyTrack = z.infer<typeof TrackSchema>;

export const EpisodeSchema = z.object({
  type: z.literal("episode"),
  id: z.string().nullish(),
  name: z.string(),
  uri: z.string(),
  duration_ms: z.number(),
  images: Images,
  show: z.object({ name: z.string(), uri: z.string().nullish(), images: Images.optional() }).nullish(),
  external_urls: ExternalUrls,
});
export type SpotifyEpisode = z.infer<typeof EpisodeSchema>;

export const PlayableSchema = z.discriminatedUnion("type", [TrackSchema, EpisodeSchema]);
export type SpotifyPlayable = z.infer<typeof PlayableSchema>;

export const PlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string(),
  owner: z.object({ id: z.string(), display_name: z.string().nullish() }).nullish(),
  images: Images,
  public: z.boolean().nullish(),
  collaborative: z.boolean().nullish(),
  external_urls: ExternalUrls,
});
export type SpotifyPlaylist = z.infer<typeof PlaylistSchema>;

export const DeviceSchema = z.object({
  id: z.string().nullish(),
  name: z.string(),
  type: z.string(),
  is_active: z.boolean(),
  is_restricted: z.boolean().nullish().transform((v) => v ?? false),
  is_private_session: z.boolean().nullish(),
  volume_percent: z.number().nullish(),
  supports_volume: z.boolean().nullish(),
});
export type SpotifyDevice = z.infer<typeof DeviceSchema>;

export const DevicesSchema = z.object({ devices: z.array(DeviceSchema) });

export const RepeatStateSchema = z.enum(["off", "track", "context"]);
export type RepeatState = z.infer<typeof RepeatStateSchema>;

/** Unknown item kinds (ads, unsupported content) collapse to `null` rather than failing. */
const MaybePlayable = z.unknown().transform((v) => {
  const parsed = PlayableSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
});

export const PlaybackStateSchema = z.object({
  device: DeviceSchema.nullish(),
  repeat_state: RepeatStateSchema.catch("off"),
  shuffle_state: z.boolean().nullish().transform((v) => v ?? false),
  context: z.object({ type: z.string(), uri: z.string() }).nullish(),
  timestamp: z.number().nullish(),
  progress_ms: z.number().nullish(),
  is_playing: z.boolean(),
  item: MaybePlayable,
  currently_playing_type: z.string().nullish(),
  actions: z.object({ disallows: z.record(z.string(), z.boolean().optional()).nullish() }).nullish(),
});
export type SpotifyPlaybackState = z.infer<typeof PlaybackStateSchema>;

export const QueueSchema = z.object({
  currently_playing: MaybePlayable,
  queue: z.array(MaybePlayable).transform((items) => items.filter((i): i is SpotifyPlayable => i !== null)),
});
export type SpotifyQueue = z.infer<typeof QueueSchema>;

const paging = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    // Search can return `null` entries (notably for playlists); drop them.
    items: z.array(item.nullable()).transform((items) => items.filter((i): i is z.infer<T> => i !== null)),
    total: z.number().nullish(),
    next: z.string().nullish(),
  });

export const SearchSchema = z.object({
  tracks: paging(TrackSchema).nullish(),
  artists: paging(ArtistSchema).nullish(),
  albums: paging(AlbumSchema).nullish(),
  playlists: paging(PlaylistSchema).nullish(),
  episodes: paging(EpisodeSchema).nullish(),
});
export type SpotifySearchResponse = z.infer<typeof SearchSchema>;

export const PlaylistPageSchema = paging(PlaylistSchema);

export const MeSchema = z.object({ id: z.string(), display_name: z.string().nullish(), uri: z.string().nullish() });
export type SpotifyMe = z.infer<typeof MeSchema>;

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type SpotifyTokenResponse = z.infer<typeof TokenResponseSchema>;

export const SEARCH_TYPES = ["track", "artist", "album", "playlist", "episode"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

