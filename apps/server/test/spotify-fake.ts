/**
 * In-memory Spotify (accounts service + Web API) used through the injected
 * `fetch`. Behaves like Spotify Connect closely enough to exercise device
 * selection, restrictions, errors and token refresh without a real account.
 */

export interface FakeDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted?: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization: string;
}

const id22 = (seed: string) => (seed.replace(/[^A-Za-z0-9]/g, "") + "0000000000000000000000").slice(0, 22);

export function track(name: string, artist: string, album = `${name} (Single)`, durationMs = 200_000) {
  return {
    type: "track",
    id: id22(`t${name}`),
    name,
    uri: `spotify:track:${id22(`t${name}`)}`,
    duration_ms: durationMs,
    artists: [{ id: id22(`a${artist}`), name: artist, uri: `spotify:artist:${id22(`a${artist}`)}` }],
    album: { id: id22(`l${album}`), name: album, uri: `spotify:album:${id22(`l${album}`)}`, images: [{ url: `https://i.scdn.co/image/${id22(album)}`, width: 300, height: 300 }], artists: [] },
    is_playable: true,
    external_urls: { spotify: `https://open.spotify.com/track/${id22(`t${name}`)}` },
  };
}

export function artist(name: string) {
  return { id: id22(`a${name}`), name, uri: `spotify:artist:${id22(`a${name}`)}`, images: [] };
}

export function album(name: string, artistName: string) {
  return { id: id22(`l${name}`), name, uri: `spotify:album:${id22(`l${name}`)}`, album_type: "album", images: [], artists: [artist(artistName)], release_date: "2024-05-17" };
}

export function playlist(name: string, owner = "spotify") {
  return { id: id22(`p${name}`), name, uri: `spotify:playlist:${id22(`p${name}`)}`, owner: { id: owner, display_name: owner === "spotify" ? "Spotify" : "Alex" }, images: [], public: false };
}

export class FakeSpotify {
  readonly clientId = "a".repeat(32);
  readonly clientSecret = "b".repeat(32);
  requests: FakeRequest[] = [];
  tokenRequests: URLSearchParams[] = [];

  devices: FakeDevice[] = [
    { id: "dev-computer", name: "DESKTOP-ALEX", type: "Computer", is_active: true, volume_percent: 50, supports_volume: true },
    { id: "dev-bedroom", name: "Bedroom Speaker", type: "Speaker", is_active: false, volume_percent: 30, supports_volume: true },
  ];
  isPlaying = true;
  progressMs = 30_000;
  shuffle = false;
  repeat: "off" | "track" | "context" = "off";
  context: { type: string; uri: string } | null = null;
  item: any = track("Good Luck, Babe!", "Chappell Roan", "Good Luck, Babe!", 218_000);
  queue: any[] = [track("Espresso", "Sabrina Carpenter"), track("Juno", "Sabrina Carpenter"), track("Feather", "Sabrina Carpenter")];

  catalog = {
    tracks: [
      track("Pink Pony Club", "Chappell Roan", "The Rise and Fall of a Midwest Princess", 258_000),
      track("Pink Pony Club - Remix", "Someone Else"),
      track("Espresso", "Sabrina Carpenter"),
      track("Espresso", "Some Cover Band"),
      track("From The Start", "Laufey"),
      track("Bohemian Rhapsody", "Queen", "A Night at the Opera", 354_000),
      track("Lunch", "Billie Eilish", "HIT ME HARD AND SOFT"),
      track("Billie Eilish", "Armani White"),
    ],
    artists: [artist("Laufey"), artist("Billie Eilish"), artist("Chappell Roan"), artist("Sabrina Carpenter"), artist("Queen")],
    albums: [album("HIT ME HARD AND SOFT", "Billie Eilish"), album("Bewitched", "Laufey"), album("A Night at the Opera", "Queen")],
    playlists: [playlist("Pink Pony Club Mix", "someone"), playlist("Laufey Radio", "someone")],
  };
  myPlaylists = [playlist("Road Trip", "spotify-user"), playlist("Discover Weekly")];

  /** Account behaviour. */
  premium = true;
  refreshRevoked = false;
  grantedScope = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private";
  /** Access tokens Spotify still accepts. */
  private readonly validTokens = new Set<string>();
  private tokenCounter = 0;
  /** One-shot scripted responses keyed by "METHOD /path". */
  private readonly scripted: Array<{ key: string; status: number; body?: unknown; headers?: Record<string, string> }> = [];

  /** Makes every issued access token invalid (as if expired), so the next call gets a 401. */
  expireAccessTokens(): void {
    this.validTokens.clear();
  }

  respondOnce(key: string, status: number, body?: unknown, headers?: Record<string, string>): void {
    this.scripted.push({ key, status, body, headers });
  }

  mutations(): FakeRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  last(method: string, path: string): FakeRequest | undefined {
    return [...this.requests].reverse().find((r) => r.method === method && r.path === path);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
    const err = (status: number, message: string, reason?: string) => json({ error: { status, message, ...(reason ? { reason } : {}) } }, status);
    const headers = new Headers(init?.headers);

    if (url.host === "accounts.spotify.com") {
      const body = new URLSearchParams(String(init?.body));
      this.tokenRequests.push(body);
      const basic = Buffer.from((headers.get("authorization") ?? "").replace(/^Basic /, ""), "base64").toString();
      if (basic !== `${this.clientId}:${this.clientSecret}`) return json({ error: "invalid_client", error_description: "Invalid client secret" }, 400);
      const grant = body.get("grant_type");
      if (grant === "client_credentials") return json({ access_token: "app-token", token_type: "Bearer", expires_in: 3600 });
      if (grant === "authorization_code") {
        if (body.get("code") !== "good-code") return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
        return json({ access_token: this.issue(), token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1", scope: this.grantedScope });
      }
      if (grant === "refresh_token") {
        if (this.refreshRevoked || body.get("refresh_token") !== "refresh-1") return json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
        return json({ access_token: this.issue(), token_type: "Bearer", expires_in: 3600, scope: this.grantedScope });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.host !== "api.spotify.com") return json({ error: "unexpected host" }, 500);

    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const query = Object.fromEntries(url.searchParams);
    const authorization = headers.get("authorization") ?? "";
    const reqBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path, query, body: reqBody, authorization });

    if (!this.validTokens.has(authorization.replace(/^Bearer /, ""))) return err(401, "The access token expired");
    const scriptedIndex = this.scripted.findIndex((s) => s.key === `${method} ${path}`);
    if (scriptedIndex >= 0) {
      const [s] = this.scripted.splice(scriptedIndex, 1);
      return typeof s!.body === "string" ? new Response(s!.body, { status: s!.status, headers: s!.headers }) : json(s!.body, s!.status, s!.headers);
    }

    const active = this.devices.find((d) => d.is_active);
    const playerCommand = (fn: (device: FakeDevice) => Response | void): Response => {
      if (!this.premium) return err(403, "Player command failed: Premium required", "PREMIUM_REQUIRED");
      let device = active;
      if (query.device_id) {
        device = this.devices.find((d) => d.id === query.device_id);
        if (!device) return err(404, "Device not found");
      }
      if (!device) return err(404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");
      if (device.is_restricted) return err(403, "Player command failed: Restriction violated", "DEVICE_NOT_CONTROLLABLE");
      return fn(device) ?? new Response(null, { status: 204 });
    };
    const activate = (device: FakeDevice) => {
      for (const d of this.devices) d.is_active = d === device;
    };

    if (method === "GET" && path === "/me") return json({ id: "spotify-user", display_name: "Alex", uri: "spotify:user:spotify-user" });
    if (method === "GET" && path === "/me/player") {
      if (!active) return new Response(null, { status: 204 });
      return json({
        device: active,
        repeat_state: this.repeat,
        shuffle_state: this.shuffle,
        context: this.context,
        timestamp: Date.now(),
        progress_ms: this.progressMs,
        is_playing: this.isPlaying,
        item: this.item,
        currently_playing_type: this.item?.type ?? "unknown",
        actions: { disallows: {} },
      });
    }
    if (method === "GET" && path === "/me/player/devices") return json({ devices: this.devices });
    if (method === "GET" && path === "/me/player/queue") return json({ currently_playing: active ? this.item : null, queue: active ? this.queue : [] });
    if (method === "GET" && path === "/me/playlists") {
      if (!this.grantedScope.includes("playlist-read-private")) return err(403, "Insufficient client scope");
      const offset = Number(query.offset ?? 0);
      const limit = Number(query.limit ?? 20);
      return json({ items: this.myPlaylists.slice(offset, offset + limit), total: this.myPlaylists.length, next: offset + limit < this.myPlaylists.length ? "next" : null });
    }
    if (method === "GET" && path === "/search") return json(this.search(query.q ?? "", (query.type ?? "").split(","), Number(query.limit ?? 5)));

    if (method === "PUT" && path === "/me/player/play") {
      return playerCommand((device) => {
        activate(device);
        if (reqBody?.uris) this.item = this.catalog.tracks.find((t) => t.uri === reqBody.uris[0]) ?? this.item;
        if (reqBody?.context_uri) this.context = { type: reqBody.context_uri.split(":")[1], uri: reqBody.context_uri };
        this.isPlaying = true;
      });
    }
    if (method === "PUT" && path === "/me/player/pause") {
      return playerCommand(() => {
        if (!this.isPlaying) return err(403, "Player command failed: Restriction violated", "ALREADY_PAUSED");
        this.isPlaying = false;
      });
    }
    if (method === "POST" && (path === "/me/player/next" || path === "/me/player/previous")) return playerCommand(() => undefined);
    if (method === "PUT" && path === "/me/player/seek") return playerCommand(() => void (this.progressMs = Number(query.position_ms)));
    if (method === "PUT" && path === "/me/player/volume") {
      return playerCommand((device) => {
        if (device.supports_volume === false) return err(403, "Player command failed: Cannot control device volume", "VOLUME_CONTROL_DISALLOW");
        device.volume_percent = Number(query.volume_percent);
      });
    }
    if (method === "PUT" && path === "/me/player/shuffle") return playerCommand(() => void (this.shuffle = query.state === "true"));
    if (method === "PUT" && path === "/me/player/repeat") return playerCommand(() => void (this.repeat = query.state as "off"));
    if (method === "POST" && path === "/me/player/queue") return playerCommand(() => void this.queue.unshift(this.catalog.tracks.find((t) => t.uri === query.uri)));
    if (method === "PUT" && path === "/me/player") {
      const target = this.devices.find((d) => d.id === reqBody?.device_ids?.[0]);
      if (!target) return err(404, "Device not found");
      if (target.is_restricted) return err(403, "Player command failed: Restriction violated", "DEVICE_NOT_CONTROLLABLE");
      activate(target);
      if (reqBody.play) this.isPlaying = true;
      return new Response(null, { status: 204 });
    }
    return err(404, `unhandled ${method} ${path}`);
  };

  private issue(): string {
    const token = `sp-access-${++this.tokenCounter}`;
    this.validTokens.add(token);
    return token;
  }

  /** Crude relevance: every query word (minus field filters) must appear in the item's text. */
  private search(q: string, types: string[], limit: number) {
    const artistFilter = /artist:(.+)$/.exec(q)?.[1]?.toLowerCase();
    const words = q.replace(/artist:.+$/, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const hit = (text: string, artists: string[] = []) => {
      const hay = `${text} ${artists.join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w)) && (!artistFilter || artists.some((a) => a.toLowerCase().includes(artistFilter)));
    };
    const page = (items: any[]) => ({ items: items.slice(0, limit), total: items.length, next: null });
    const out: Record<string, unknown> = {};
    if (types.includes("track")) out.tracks = page(this.catalog.tracks.filter((t) => hit(t.name, t.artists.map((a) => a.name))));
    if (types.includes("artist")) out.artists = page(this.catalog.artists.filter((a) => hit(a.name)));
    if (types.includes("album")) out.albums = page(this.catalog.albums.filter((a) => hit(a.name, a.artists.map((x) => x.name))));
    // Spotify's search really does return null playlist entries; keep one to prove they're tolerated.
    if (types.includes("playlist")) out.playlists = { ...page(this.catalog.playlists.filter((p) => hit(p.name))), items: [null, ...this.catalog.playlists.filter((p) => hit(p.name)).slice(0, limit)] };
    if (types.includes("episode")) out.episodes = page([]);
    return out;
  }
}
