import { toolCall } from "@lou/agent";
import { BUILTIN_FAMILIES, selectFamilies } from "@lou/tools";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { oauthConnections, settings } from "../src/db/schema";
import { SpotifyApi } from "../src/integrations/spotify/client";
import { connectSpotify, pairDevice, startTestServer, waitForBus, type TestServer } from "./helpers";
import { FakeSpotify } from "./spotify-fake";

let server: TestServer;
afterEach(async () => server?.close());

async function setup(options: { fake?: FakeSpotify; sleeps?: number[]; steps?: any[] } = {}) {
  const fake = options.fake ?? new FakeSpotify();
  server = await startTestServer({ spotify: fake, sleeps: options.sleeps, steps: options.steps });
  const device = await pairDevice(server);
  const auth = { authorization: `Bearer ${device.deviceToken}` };
  const accountId = await connectSpotify(server, device.deviceToken);
  return { fake, auth, accountId, device };
}

async function tool(toolId: string, input: Record<string, unknown> = {}) {
  const out = await server.services.executor.invoke({ toolId, rawInput: input, caller: "system", userId: server.services.owner.id, tainted: false, signal: new AbortController().signal });
  if (out.kind !== "result") throw new Error(`unexpected outcome ${JSON.stringify(out)}`);
  return out.result as { success: true; data: any } | { success: false; error: { code: string; message: string; details?: any } };
}

async function ok(toolId: string, input: Record<string, unknown> = {}) {
  const r = await tool(toolId, input);
  if (!r.success) throw new Error(`${toolId} failed: ${r.error.code} ${r.error.message}`);
  return r.data;
}

async function failure(toolId: string, input: Record<string, unknown> = {}) {
  const r = await tool(toolId, input);
  if (r.success) throw new Error(`${toolId} unexpectedly succeeded: ${JSON.stringify(r.data)}`);
  return r.error;
}

describe("Spotify setup and connection", () => {
  it("reports not configured, then accepts app credentials from the setup dialog without exposing the secret", async () => {
    const fake = new FakeSpotify();
    server = await startTestServer({ spotify: fake, spotifyEnv: false });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };

    const before = await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth });
    expect(before.json()).toMatchObject({ state: "not_configured", configSource: null, redirectUri: "http://127.0.0.1:8787/oauth/spotify/callback" });
    // An agent request gets an actionable path instead of an internal error.
    expect(await failure("spotify.play", { query: "music" })).toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("Accounts → Spotify") });

    const bad = await server.app.inject({ method: "PUT", url: "/api/spotify/app", headers: auth, payload: { clientId: fake.clientId, clientSecret: "c".repeat(32) } });
    expect(bad.statusCode).toBe(503);
    expect(bad.json().error.message).toContain("rejected");

    const saved = await server.app.inject({ method: "PUT", url: "/api/spotify/app", headers: auth, payload: { clientId: fake.clientId, clientSecret: fake.clientSecret } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ state: "disconnected", configSource: "server", clientId: fake.clientId });
    expect(saved.body).not.toContain(fake.clientSecret);
    const stored = JSON.stringify(server.services.db.select().from(settings).where(eq(settings.key, "spotify_app")).get());
    expect(stored).not.toContain(fake.clientSecret);
    expect(fake.tokenRequests.at(-1)?.get("grant_type")).toBe("client_credentials");

    await connectSpotify(server, device.deviceToken);
    expect((await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth })).json()).toMatchObject({ state: "connected", account: { displayName: "Alex", spotifyUserId: "spotify-user" } });
  });

  it("connects with Authorization Code + state and stores only encrypted tokens", async () => {
    const fake = new FakeSpotify();
    server = await startTestServer({ spotify: fake });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };

    const start = await server.app.inject({ method: "POST", url: "/api/accounts/spotify/connect", headers: auth });
    const url = new URL(start.json().authUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: fake.clientId,
      response_type: "code",
      redirect_uri: "http://127.0.0.1:8787/oauth/spotify/callback",
      scope: "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private",
    });
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.toString()).not.toContain(fake.clientSecret);

    // A forged or replayed state is rejected.
    const forged = await server.app.inject({ method: "GET", url: "/oauth/spotify/callback?code=good-code&state=forged" });
    expect(forged.statusCode).toBe(400);
    const state = url.searchParams.get("state")!;
    expect((await server.app.inject({ method: "GET", url: `/oauth/spotify/callback?code=good-code&state=${state}` })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "GET", url: `/oauth/spotify/callback?code=good-code&state=${state}` })).statusCode).toBe(400);

    const accounts = (await server.app.inject({ method: "GET", url: "/api/accounts", headers: auth })).json();
    expect(accounts.available.spotify).toBe(true);
    expect(accounts.items).toEqual([expect.objectContaining({ provider: "spotify", displayName: "Alex", status: "connected" })]);
    const conn = server.services.db.select().from(oauthConnections).get()!;
    expect(JSON.stringify(conn)).not.toMatch(/sp-access|refresh-1/);
    expect(conn.scopes).toContain("user-modify-playback-state");

    const health = (await server.app.inject({ method: "GET", url: "/health" })).json();
    expect(health.integrations.spotify).toBe(true);
  });

  it("rejects a grant that is missing required scopes", async () => {
    const fake = new FakeSpotify();
    fake.grantedScope = "user-read-playback-state";
    server = await startTestServer({ spotify: fake });
    const device = await pairDevice(server);
    await expect(connectSpotify(server, device.deviceToken)).rejects.toThrow(/permissions/);
  });

  it("refreshes expired access tokens automatically", async () => {
    const { fake } = await setup();
    fake.expireAccessTokens();
    const state = await ok("spotify.get_playback_state");
    expect(state).toMatchObject({ active: true, item: { name: "Good Luck, Babe!" } });
    expect(fake.tokenRequests.filter((b) => b.get("grant_type") === "refresh_token")).toHaveLength(1);
    const calls = fake.requests.filter((r) => r.path === "/me/player");
    expect(calls.at(-2)!.authorization).not.toBe(calls.at(-1)!.authorization);
  });

  it("marks revoked authorization as needing reconnect and stops calling Spotify", async () => {
    const { fake, auth } = await setup();
    fake.expireAccessTokens();
    fake.refreshRevoked = true;
    const error = await failure("spotify.pause");
    expect(error).toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("Reconnect") });
    expect((await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth })).json().state).toBe("needs_reauth");

    const callsBefore = fake.requests.length + fake.tokenRequests.length;
    expect(await failure("spotify.next")).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fake.requests.length + fake.tokenRequests.length).toBe(callsBefore);

    // Reconnecting restores the account.
    fake.refreshRevoked = false;
    const device = await pairDevice(server, "Laptop");
    await connectSpotify(server, device.deviceToken);
    expect((await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth })).json().state).toBe("connected");
    await ok("spotify.next");
  });

  it("disconnects", async () => {
    const { auth, accountId } = await setup();
    await server.app.inject({ method: "DELETE", url: `/api/accounts/${accountId}`, headers: auth });
    expect((await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth })).json().state).toBe("disconnected");
    expect(await failure("spotify.play", {})).toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("Connect Spotify") });
  });
});

describe("Spotify playback tools", () => {
  it("reports playback state compactly", async () => {
    const { fake } = await setup();
    fake.shuffle = true;
    expect(await ok("spotify.get_playback_state")).toEqual({
      active: true,
      isPlaying: true,
      item: { type: "track", name: "Good Luck, Babe!", artists: ["Chappell Roan"], album: "Good Luck, Babe!", uri: fake.item.uri },
      position: "0:30",
      duration: "3:38",
      device: { name: "DESKTOP-ALEX", type: "Computer", volumePercent: 50, supportsVolume: true },
      shuffle: true,
      repeat: "off",
    });
    fake.devices.forEach((d) => (d.is_active = false));
    expect(await ok("spotify.get_playback_state")).toMatchObject({ active: false });
  });

  it("plays a song by name", async () => {
    const { fake } = await setup();
    const result = await ok("spotify.play", { query: "Pink Pony Club" });
    expect(result).toMatchObject({ playing: { type: "track", name: "Pink Pony Club", by: "Chappell Roan" }, resumed: false });
    expect(fake.last("PUT", "/me/player/play")!.body).toEqual({ uris: [fake.catalog.tracks[0]!.uri] });
    expect(fake.mutations()).toHaveLength(1);
  });

  it("plays artists, albums, playlists and liked songs as contexts", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.play", { query: "some Laufey" })).toMatchObject({ playing: { type: "artist", name: "Laufey" } });
    expect(fake.last("PUT", "/me/player/play")!.body).toEqual({ context_uri: fake.catalog.artists[0]!.uri });

    expect(await ok("spotify.play", { query: "Billie Eilish" })).toMatchObject({ playing: { type: "artist", name: "Billie Eilish" } });
    expect(await ok("spotify.play", { query: "Hit Me Hard and Soft" })).toMatchObject({ playing: { type: "album", name: "HIT ME HARD AND SOFT" } });
    expect(await ok("spotify.play", { query: "my Discover Weekly" })).toMatchObject({ playing: { type: "playlist", name: "Discover Weekly" } });
    expect(fake.last("PUT", "/me/player/play")!.body).toEqual({ context_uri: fake.myPlaylists[1]!.uri });
    expect(await ok("spotify.play", { query: "my liked songs" })).toMatchObject({ playing: { type: "playlist", name: "Liked Songs" } });
    expect(fake.last("PUT", "/me/player/play")!.body).toEqual({ context_uri: "spotify:user:spotify-user:collection" });
    expect(await ok("spotify.play", { query: "Espresso by Sabrina Carpenter" })).toMatchObject({ playing: { name: "Espresso", by: "Sabrina Carpenter" } });
  });

  it("resumes, and reports nothing found", async () => {
    const { fake } = await setup();
    fake.isPlaying = false;
    expect(await ok("spotify.play")).toEqual({ playing: null, resumed: true, device: null });
    expect(fake.last("PUT", "/me/player/play")!.body).toBeUndefined();
    expect(await failure("spotify.play", { query: "zzzz qqqq" })).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Nothing on Spotify") });
    // URIs must look like real Spotify URIs (they come from tool results, never invented).
    expect(await failure("spotify.play", { uri: "spotify:track:made-up" })).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("plays on a named device in a single transfer-and-play request", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.play", { query: "Bohemian Rhapsody", deviceName: "my bedroom speaker" })).toMatchObject({ playing: { name: "Bohemian Rhapsody" }, device: "Bedroom Speaker" });
    expect(fake.last("PUT", "/me/player/play")!.query.device_id).toBe("dev-bedroom");
    expect(fake.mutations()).toHaveLength(1);
  });

  it("pauses, skips, goes back", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.pause")).toEqual({ paused: true });
    expect(await ok("spotify.pause")).toEqual({ paused: true, note: "Already paused." });
    expect(await ok("spotify.next")).toEqual({ skipped: true });
    expect(await ok("spotify.previous")).toEqual({ wentBack: true });
    expect(fake.mutations().map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /me/player/pause", "PUT /me/player/pause", "POST /me/player/next", "POST /me/player/previous"]);
  });

  it("seeks to a time, relatively, and restarts", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.seek", { position: "1:32" })).toMatchObject({ position: "1:32", positionMs: 92_000, duration: "3:38" });
    expect(fake.last("PUT", "/me/player/seek")!.query.position_ms).toBe("92000");
    expect(await ok("spotify.seek", { offsetSeconds: 30 })).toMatchObject({ positionMs: 122_000 });
    expect(await ok("spotify.seek", { offsetSeconds: -600 })).toMatchObject({ positionMs: 0 });
    expect(await ok("spotify.seek", { restart: true })).toMatchObject({ positionMs: 0 });
    expect(await failure("spotify.seek", { position: "9:00" })).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("past the end") });
    expect(await failure("spotify.seek", { position: "1:32", restart: true })).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("sets volume absolutely and relatively, clamped, only on devices that allow it", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.set_volume", { volumePercent: 40 })).toEqual({ volumePercent: 40, previousPercent: 50, device: "DESKTOP-ALEX" });
    expect(await ok("spotify.set_volume", { change: -10 })).toMatchObject({ volumePercent: 30, previousPercent: 40 });
    expect(await ok("spotify.set_volume", { change: 90 })).toMatchObject({ volumePercent: 100 });
    expect(await ok("spotify.set_volume", { change: -100 })).toMatchObject({ volumePercent: 0 });
    expect(await failure("spotify.set_volume", { volumePercent: 140 })).toMatchObject({ code: "VALIDATION_FAILED" });

    fake.devices[0]!.supports_volume = false;
    const before = fake.mutations().length;
    expect(await failure("spotify.set_volume", { change: 10 })).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("doesn't allow its volume") });
    expect(fake.mutations()).toHaveLength(before);
  });

  it("sets shuffle and repeat", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.set_shuffle", { enabled: true })).toEqual({ shuffle: true });
    expect(fake.shuffle).toBe(true);
    expect(await ok("spotify.set_repeat", { mode: "track" })).toEqual({ repeat: "track" });
    expect(fake.last("PUT", "/me/player/repeat")!.query.state).toBe("track");
    expect(await failure("spotify.set_repeat", { mode: "forever" })).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("adds to and reads the queue, normalized and limited", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.add_to_queue", { query: "Espresso by Sabrina Carpenter" })).toMatchObject({ queued: { type: "track", name: "Espresso", by: "Sabrina Carpenter" } });
    expect(fake.last("POST", "/me/player/queue")!.query.uri).toBe(fake.catalog.tracks[2]!.uri);
    const queue = await ok("spotify.get_queue", { limit: 2 });
    expect(queue).toEqual({ currentlyPlaying: { name: "Good Luck, Babe!", by: "Chappell Roan", uri: fake.item.uri }, upNext: [expect.objectContaining({ name: "Espresso" }), expect.objectContaining({ name: "Espresso" })] });
    expect(await failure("spotify.add_to_queue", { uri: fake.catalog.albums[0]!.uri })).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("searches compactly and tolerates null entries", async () => {
    await setup();
    const res = await ok("spotify.search", { query: "Laufey" });
    expect(res.artists).toEqual([{ name: "Laufey", uri: expect.stringMatching(/^spotify:artist:/) }]);
    expect(res.tracks[0]).toEqual({ name: "From The Start", by: "Laufey", album: "From The Start (Single)", duration: "3:20", uri: expect.any(String) });
    expect(res.playlists).toEqual([{ name: "Laufey Radio", owner: "Alex", uri: expect.any(String), yours: false }]);
  });
});

describe("Spotify Connect devices", () => {
  it("lists devices and transfers playback by name", async () => {
    const { fake } = await setup();
    expect(await ok("spotify.list_devices")).toEqual({
      devices: [
        { id: "dev-computer", name: "DESKTOP-ALEX", type: "Computer", isActive: true, isRestricted: false, volumePercent: 50, supportsVolume: true },
        { id: "dev-bedroom", name: "Bedroom Speaker", type: "Speaker", isActive: false, isRestricted: false, volumePercent: 30, supportsVolume: true },
      ],
      active: "DESKTOP-ALEX",
    });
    expect(await ok("spotify.transfer_playback", { deviceName: "bedroom speaker", play: true })).toEqual({ transferred: true, device: "Bedroom Speaker" });
    expect(fake.last("PUT", "/me/player")!.body).toEqual({ device_ids: ["dev-bedroom"], play: true });
    expect(await ok("spotify.transfer_playback", { deviceName: "my computer" })).toEqual({ transferred: true, device: "DESKTOP-ALEX" });
    expect(await ok("spotify.transfer_playback", { deviceName: "my computer" })).toMatchObject({ transferred: false });
  });

  it("asks when a device name is ambiguous or unknown", async () => {
    const { fake } = await setup();
    fake.devices.push({ id: "dev-kitchen", name: "Kitchen Speaker", type: "Speaker", is_active: false, volume_percent: 40 });
    const ambiguous = await failure("spotify.transfer_playback", { deviceName: "the speaker" });
    expect(ambiguous).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(ambiguous.message).toContain("Bedroom Speaker");
    expect(ambiguous.message).toContain("Kitchen Speaker");
    expect(ambiguous.message).toContain("Ask the user");
    expect(await failure("spotify.play", { query: "Pink Pony Club", deviceName: "garage" })).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("No Spotify device matches") });
    expect(fake.mutations()).toHaveLength(0);
  });

  it("does not send commands to restricted devices", async () => {
    const { fake } = await setup();
    fake.devices[1]!.is_restricted = true;
    expect(await failure("spotify.transfer_playback", { deviceName: "Bedroom Speaker" })).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("can't be controlled") });
    expect(fake.mutations()).toHaveLength(0);
  });

  it("uses the only available device when nothing is active", async () => {
    const { fake } = await setup();
    fake.devices = [{ ...fake.devices[1]!, is_active: false }];
    expect(await ok("spotify.play", { query: "Pink Pony Club" })).toMatchObject({ device: "Bedroom Speaker" });
    expect(fake.requests.filter((r) => r.path === "/me/player/play").map((r) => r.query.device_id)).toEqual([undefined, "dev-bedroom"]);
  });

  it("does not pick between several idle devices", async () => {
    const { fake } = await setup();
    fake.devices.forEach((d) => (d.is_active = false));
    const error = await failure("spotify.play", { query: "Pink Pony Club" });
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(error.message).toMatch(/DESKTOP-ALEX.*Bedroom Speaker/);
    expect(error.message).toContain("device_name");
    expect(await failure("spotify.next")).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Ask the user which device") });
    expect(await ok("spotify.pause")).toEqual({ paused: true, note: "Nothing was playing." });
  });

  it("explains when the Spotify app is closed everywhere", async () => {
    const { fake } = await setup();
    fake.devices = [];
    for (const [id, input] of [["spotify.play", { query: "Pink Pony Club" }], ["spotify.seek", { position: "1:00" }], ["spotify.set_volume", { volumePercent: 10 }]] as const) {
      expect(await failure(id, input)).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Open the Spotify app") });
    }
  });
});

describe("Spotify API errors", () => {
  it("honours Retry-After on rate limits, then gives up with RATE_LIMITED", async () => {
    const sleeps: number[] = [];
    const { fake } = await setup({ sleeps });
    fake.respondOnce("POST /me/player/next", 429, { error: { status: 429, message: "API rate limit exceeded" } }, { "retry-after": "2" });
    expect(await ok("spotify.next")).toEqual({ skipped: true });
    expect(sleeps).toEqual([2000]);

    fake.respondOnce("POST /me/player/next", 429, { error: { status: 429, message: "API rate limit exceeded" } }, { "retry-after": "120" });
    expect(await failure("spotify.next")).toMatchObject({ code: "RATE_LIMITED", message: expect.stringContaining("2 minutes") });
  });

  it("explains Premium requirements", async () => {
    const { fake } = await setup();
    fake.premium = false;
    expect(await failure("spotify.play", { query: "Pink Pony Club" })).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Premium") });
  });

  it("explains users missing from a development-mode app", async () => {
    const { fake } = await setup();
    fake.respondOnce("GET /me/player", 403, { error: { status: 403, message: "Check settings on developer.spotify.com/dashboard, the user may not be registered." } });
    expect(await failure("spotify.get_playback_state")).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("User Management") });
  });

  it("fails cleanly on malformed responses", async () => {
    const { fake } = await setup();
    fake.respondOnce("GET /me/player", 200, { is_playing: "very", device: 7 });
    expect(await failure("spotify.get_playback_state")).toMatchObject({ code: "UPSTREAM_ERROR", message: "Spotify returned an unexpected response." });
    fake.respondOnce("GET /me/player/devices", 200, "<html>oops</html>");
    expect(await failure("spotify.list_devices")).toMatchObject({ code: "UPSTREAM_ERROR", message: "Spotify returned a malformed response." });
  });

  it("marks the account unavailable on outages and recovers", async () => {
    const { fake, auth } = await setup();
    fake.respondOnce("GET /me/player", 503, { error: { status: 503, message: "Service unavailable" } });
    fake.respondOnce("GET /me/player", 503, { error: { status: 503, message: "Service unavailable" } });
    expect(await failure("spotify.get_playback_state")).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect((await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth })).json().state).toBe("unavailable");
    await ok("spotify.get_playback_state");
    expect((await server.app.inject({ method: "GET", url: "/api/spotify", headers: auth })).json().state).toBe("connected");
  });

  it("never retries a player mutation after a network failure, but retries reads once", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new TypeError("network down");
    }) as typeof fetch;
    const api = new SpotifyApi(async () => "token", fetchImpl, { sleep: async () => undefined });
    await expect(api.next()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls).toBe(1);
    await expect(api.devices()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls).toBe(3);
  });
});

describe("Now Playing endpoint", () => {
  it("serves a cached player view and accepts remote-control actions", async () => {
    const { fake, auth } = await setup();
    const first = await server.app.inject({ method: "GET", url: "/api/spotify/player", headers: auth });
    expect(first.json()).toMatchObject({ active: true, isPlaying: true, item: { name: "Good Luck, Babe!", imageUrl: expect.stringContaining("i.scdn.co"), url: expect.stringContaining("open.spotify.com") }, progressMs: 30_000 });
    await server.app.inject({ method: "GET", url: "/api/spotify/player", headers: auth });
    expect(fake.requests.filter((r) => r.path === "/me/player" && r.method === "GET")).toHaveLength(1);

    expect((await server.app.inject({ method: "POST", url: "/api/spotify/player", headers: auth, payload: { action: "pause" } })).statusCode).toBe(200);
    // A mutation invalidates the cache so the next read reflects it.
    expect((await server.app.inject({ method: "GET", url: "/api/spotify/player", headers: auth })).json().isPlaying).toBe(false);
    expect((await server.app.inject({ method: "POST", url: "/api/spotify/player", headers: auth, payload: { action: "volume", volumePercent: 20 } })).statusCode).toBe(200);
    expect(fake.devices[0]!.volume_percent).toBe(20);
  });
});

describe("Spotify agent integration", () => {
  it("routes music requests to the Spotify family", () => {
    for (const text of ["Play Pink Pony Club", "Pause Spotify", "Skip this song", "Turn shuffle on", "Set the volume to 40%", "Queue Espresso by Sabrina Carpenter", "What's playing?", "Repeat this song", "Play my Discover Weekly", "Go back"]) {
      expect(selectFamilies(text, BUILTIN_FAMILIES), text).toContain("spotify");
    }
    expect(selectFamilies("Reply to Sarah's email", BUILTIN_FAMILIES)).not.toContain("spotify");
  });

  it("registers structured, model-facing tool schemas", async () => {
    await setup();
    const registry = server.services.registry;
    const ids = registry.byFamily("spotify").map((d) => d.id).sort();
    expect(ids).toEqual([
      "spotify.add_to_queue",
      "spotify.get_playback_state",
      "spotify.get_queue",
      "spotify.list_devices",
      "spotify.next",
      "spotify.pause",
      "spotify.play",
      "spotify.previous",
      "spotify.search",
      "spotify.seek",
      "spotify.set_repeat",
      "spotify.set_shuffle",
      "spotify.set_volume",
      "spotify.transfer_playback",
    ]);
    const play = registry.modelSpecs(["spotify.play"])[0]!;
    expect(play.parameters).toMatchObject({ type: "object", properties: { query: { type: "string" }, type: { enum: ["track", "album", "artist", "playlist"] }, deviceName: { type: "string" }, uri: { type: "string" } } });
    expect(registry.modelSpecs(["spotify.set_repeat"])[0]!.parameters).toMatchObject({ properties: { mode: { enum: ["off", "track", "context"] } }, required: ["mode"] });
    for (const def of registry.byFamily("spotify")) {
      expect(def).toMatchObject({ executionTarget: "server", exposure: "model", requiresApproval: false });
      expect(def.risk).toBe(def.id.match(/get_|list_|search/) ? "read" : "write");
    }
    expect(registry.list().some((d) => /http|request|fetch/.test(d.id))).toBe(false);
  });

  it("lets the agent play a song by name without secrets entering model context", async () => {
    const steps = [
      (req: any) => {
        expect(req.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["spotify.play", "spotify.pause", "spotify.next"]));
        expect(JSON.stringify(req)).not.toMatch(/sp-access|refresh-1|bbbbbbbbbbbbbbbb/);
        return { toolCalls: [toolCall("spotify.play", { query: "Pink Pony Club" })] };
      },
      (req: any) => {
        const context = JSON.stringify(req);
        expect(context).toContain("Pink Pony Club");
        expect(context).toContain('<external_data source=\\"spotify.play\\"');
        expect(context).not.toMatch(/sp-access|refresh-1|bbbbbbbbbbbbbbbb|Bearer/);
        return { text: "Playing Pink Pony Club by Chappell Roan." };
      },
    ];
    const { fake, auth } = await setup({ steps });
    const done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "Play Pink Pony Club" } });
    expect(await done).toMatchObject({ status: "completed", message: "Playing Pink Pony Club by Chappell Roan." });
    expect(fake.last("PUT", "/me/player/play")!.body).toEqual({ uris: [fake.catalog.tracks[0]!.uri] });
  });
});
