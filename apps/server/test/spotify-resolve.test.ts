import { describe, expect, it } from "vitest";
import {
  formatDuration,
  matchDevice,
  parsePlayQuery,
  parseTimestamp,
  rankResults,
  summarizePlayback,
  uriType,
  type DeviceSummary,
} from "../src/integrations/spotify/resolve";
import { PlaybackStateSchema, PlaylistSchema, SearchSchema } from "../src/integrations/spotify/types";
import { album, artist, FakeSpotify, playlist, track } from "./spotify-fake";

const dev = (name: string, type: string, extra: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id: `id-${name}`,
  name,
  type,
  isActive: false,
  isRestricted: false,
  volumePercent: 50,
  supportsVolume: true,
  ...extra,
});

describe("time parsing", () => {
  it.each([
    ["1:32", 92_000],
    ["0:05", 5_000],
    ["1:02:03", 3_723_000],
    ["92", 92_000],
    ["92s", 92_000],
    ["1m32s", 92_000],
    ["1 min 32 sec", 92_000],
    ["2 minutes", 120_000],
    ["1 minute and 30 seconds", 90_000],
  ])("parses %s", (input, ms) => expect(parseTimestamp(input)).toBe(ms));

  it.each(["", "abc", "1:75", "soon", "1:32 please"])("rejects %j", (input) => expect(parseTimestamp(input)).toBeNull());

  it("formats durations", () => {
    expect(formatDuration(92_000)).toBe("1:32");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("device matching", () => {
  const devices = [dev("DESKTOP-ALEX", "Computer", { isActive: true }), dev("Bedroom Speaker", "Speaker"), dev("Kitchen Speaker", "Speaker"), dev("Alex's iPhone", "Smartphone")];

  it("matches exact names and ids", () => {
    expect(matchDevice(devices, { name: "bedroom speaker" })).toMatchObject({ kind: "match", device: { name: "Bedroom Speaker" } });
    expect(matchDevice(devices, { id: "id-Kitchen Speaker" })).toMatchObject({ kind: "match", device: { name: "Kitchen Speaker" } });
  });

  it("matches words of the name, ignoring filler", () => {
    expect(matchDevice(devices, { name: "my bedroom speaker" })).toMatchObject({ kind: "match", device: { name: "Bedroom Speaker" } });
    expect(matchDevice(devices, { name: "the kitchen" })).toMatchObject({ kind: "match", device: { name: "Kitchen Speaker" } });
  });

  it("matches device kinds", () => {
    expect(matchDevice(devices, { name: "my computer" })).toMatchObject({ kind: "match", device: { name: "DESKTOP-ALEX" } });
    expect(matchDevice(devices, { name: "my PC" })).toMatchObject({ kind: "match", device: { name: "DESKTOP-ALEX" } });
    expect(matchDevice(devices, { name: "my phone" })).toMatchObject({ kind: "match", device: { name: "Alex's iPhone" } });
  });

  it("reports ambiguity instead of guessing", () => {
    const m = matchDevice(devices, { name: "the speaker" });
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.candidates.map((d) => d.name)).toEqual(["Bedroom Speaker", "Kitchen Speaker"]);
  });

  it("prefers the one controllable device among several matches", () => {
    const m = matchDevice([dev("Bedroom Speaker", "Speaker", { isRestricted: true }), dev("Kitchen Speaker", "Speaker")], { name: "speaker" });
    expect(m).toMatchObject({ kind: "match", device: { name: "Kitchen Speaker" } });
  });

  it("falls back from a stale id to the name, and reports no match", () => {
    expect(matchDevice(devices, { id: "gone", name: "kitchen speaker" })).toMatchObject({ kind: "match", device: { name: "Kitchen Speaker" } });
    expect(matchDevice(devices, { name: "garage" })).toEqual({ kind: "none" });
    expect(matchDevice(devices, { id: "gone" })).toEqual({ kind: "none" });
  });
});

describe("play query parsing", () => {
  it("understands cue words", () => {
    expect(parsePlayQuery("some Laufey")).toMatchObject({ text: "Laufey", type: "artist" });
    expect(parsePlayQuery("the album Bewitched")).toMatchObject({ text: "Bewitched", type: "album" });
    expect(parsePlayQuery("Road Trip playlist")).toMatchObject({ text: "Road Trip", type: "playlist" });
    expect(parsePlayQuery("Espresso by Sabrina Carpenter")).toMatchObject({ text: "Espresso", artist: "Sabrina Carpenter" });
    expect(parsePlayQuery("my Discover Weekly")).toMatchObject({ text: "Discover Weekly", type: "playlist", mine: true });
    expect(parsePlayQuery("Discover Weekly")).toMatchObject({ mine: true, type: "playlist" });
    expect(parsePlayQuery("my liked songs")).toMatchObject({ likedSongs: true });
    expect(parsePlayQuery("Pink Pony Club")).toEqual({ text: "Pink Pony Club", type: undefined, artist: undefined, mine: false, likedSongs: false });
  });

  it("keeps an explicit type", () => {
    expect(parsePlayQuery("the song Bewitched", "track")).toMatchObject({ text: "Bewitched", type: "track" });
  });
});

describe("result ranking", () => {
  const fake = new FakeSpotify();
  const results = (extra: Record<string, unknown[]>) =>
    SearchSchema.parse(Object.fromEntries(Object.entries(extra).map(([k, items]) => [k, { items, total: items.length, next: null }])));

  it("plays an artist for an artist name rather than a song titled after them", () => {
    const r = results({ tracks: [track("Billie Eilish", "Armani White"), track("Lunch", "Billie Eilish")], artists: [artist("Billie Eilish")], albums: [], playlists: [] });
    expect(rankResults(parsePlayQuery("Billie Eilish"), r)).toMatchObject({ type: "artist", name: "Billie Eilish" });
  });

  it("plays an album when the album name matches exactly", () => {
    const r = results({ tracks: [track("Lunch", "Billie Eilish", "HIT ME HARD AND SOFT")], artists: [], albums: [album("HIT ME HARD AND SOFT", "Billie Eilish")], playlists: [] });
    expect(rankResults(parsePlayQuery("Hit Me Hard and Soft"), r)).toMatchObject({ type: "album", name: "HIT ME HARD AND SOFT" });
  });

  it("plays the original track over remixes and covers", () => {
    const r = results({ tracks: [track("Pink Pony Club - Remix", "Someone"), track("Pink Pony Club", "Chappell Roan")], artists: [], albums: [], playlists: [playlist("Pink Pony Club Mix")] });
    expect(rankResults(parsePlayQuery("Pink Pony Club"), r)).toMatchObject({ type: "track", name: "Pink Pony Club", by: "Chappell Roan" });
    const espresso = results({ tracks: [track("Espresso", "Some Cover Band"), track("Espresso", "Sabrina Carpenter")] });
    expect(rankResults(parsePlayQuery("Espresso by Sabrina Carpenter"), espresso)).toMatchObject({ by: "Sabrina Carpenter" });
  });

  it("prefers the user's own playlist for 'my …'", () => {
    const r = results({ playlists: [playlist("Discover Weekly Vibes", "someone")] });
    expect(rankResults(parsePlayQuery("my Discover Weekly"), r, fake.myPlaylists.map((p) => PlaylistSchema.parse(p)))).toMatchObject({
      type: "playlist",
      name: "Discover Weekly",
    });
  });

  it("returns null when nothing matched", () => {
    expect(rankResults(parsePlayQuery("zzz"), results({ tracks: [] }))).toBeNull();
  });
});

describe("normalization", () => {
  it("summarizes playback compactly and tolerates nulls and unknown items", () => {
    const fake = new FakeSpotify();
    const state = PlaybackStateSchema.parse({ device: fake.devices[0], repeat_state: "context", shuffle_state: true, progress_ms: 61_000, is_playing: true, item: fake.item, context: null });
    expect(summarizePlayback(state)).toEqual({
      isPlaying: true,
      item: { type: "track", name: "Good Luck, Babe!", artists: ["Chappell Roan"], album: "Good Luck, Babe!", uri: fake.item.uri, durationMs: 218_000, imageUrl: expect.stringContaining("i.scdn.co"), url: expect.stringContaining("open.spotify.com") },
      progressMs: 61_000,
      device: { id: "dev-computer", name: "DESKTOP-ALEX", type: "Computer", isActive: true, isRestricted: false, volumePercent: 50, supportsVolume: true },
      shuffle: true,
      repeat: "context",
      context: null,
    });
    // Ads and other unknown items become null rather than failing.
    const ad = PlaybackStateSchema.parse({ device: null, repeat_state: "weird", shuffle_state: null, progress_ms: null, is_playing: false, item: { type: "ad" } });
    expect(summarizePlayback(ad)).toMatchObject({ item: null, repeat: "off", shuffle: false, device: null });
    expect(summarizePlayback(null)).toMatchObject({ isPlaying: false, item: null });
  });

  it("recognises Spotify URIs only", () => {
    expect(uriType(track("X", "Y").uri)).toBe("track");
    expect(uriType("spotify:user:abc:collection")).toBe("collection");
    expect(uriType("spotify:track:short")).toBeNull();
    expect(uriType("https://open.spotify.com/track/x")).toBeNull();
  });
});
