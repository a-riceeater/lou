import type { ToolRegistry } from "@lou/tools";
import { z } from "zod";
import { formatDuration } from "./resolve";
import type { SpotifyPlayer } from "./player";
import { SEARCH_TYPES } from "./types";

/**
 * Spotify capabilities exposed to the agent. Every tool takes intent-level,
 * structured input; the server resolves names, searches, picks IDs and devices,
 * and validates before calling Spotify. There is no raw HTTP escape hatch.
 *
 * Catalog and listening data (track, artist, playlist and episode names) is
 * third-party text, so tools returning it are marked untrusted. Device names are
 * the user's own labels. Results are compact summaries, never raw payloads.
 */

const deviceName = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe('Spotify Connect device by the name or kind the user said, e.g. "Bedroom Speaker", "my phone", "my computer". Omit to use the active device.');
const spotifyDeviceId = z.string().min(1).max(100).optional().describe("Spotify device ID from spotify.list_devices. Prefer deviceName; IDs can change.");
const spotifyUri = z
  .string()
  .regex(/^spotify:(track|album|artist|playlist|episode|show):[A-Za-z0-9]{22}$|^spotify:user:[^:\s]+:collection$/, "Must be a Spotify URI returned by a Spotify tool")
  .optional();

const base = { family: "spotify", executionTarget: "server" as const, exposure: "model" as const, requiresApproval: false };

export function registerSpotifyTools(registry: ToolRegistry, player: SpotifyPlayer): void {
  registry.register(
    {
      ...base,
      id: "spotify.get_playback_state",
      title: "Checking Spotify",
      description:
        "What is playing on Spotify right now: track or episode, artists, album, position, whether it is playing or paused, the active device, volume, shuffle and repeat. Use for \"what's playing?\", \"what song is this?\", \"what device is Spotify on?\".",
      input: z.object({}),
      risk: "read",
      untrustedOutput: true,
    },
    {
      async execute(_input, ctx) {
        const s = await player.playback(ctx.userId, { signal: ctx.signal });
        if (!s.device) return { active: false, message: "Nothing is playing on Spotify right now (no active device)." };
        return {
          active: true,
          isPlaying: s.isPlaying,
          item: s.item ? { type: s.item.type, name: s.item.name, artists: s.item.artists, album: s.item.album, uri: s.item.uri } : null,
          position: formatDuration(s.progressMs),
          duration: s.item ? formatDuration(s.item.durationMs) : null,
          device: { name: s.device.name, type: s.device.type, volumePercent: s.device.volumePercent, supportsVolume: s.device.supportsVolume },
          shuffle: s.shuffle,
          repeat: s.repeat,
          ...(s.context ? { context: s.context } : {}),
        };
      },
    },
  );

  registry.register(
    {
      ...base,
      id: "spotify.play",
      title: "Playing on Spotify",
      description:
        'Play music on Spotify, or resume. Pass the user\'s words as `query` ("Pink Pony Club", "Espresso by Sabrina Carpenter", "some Laufey", "Hit Me Hard and Soft", "my Discover Weekly", "my liked songs"); the server searches and picks the best song, artist, album or playlist. Set `type` only when the user said it ("the album …", "the playlist …"). Call with no query to resume. Add deviceName to play on a specific speaker/device ("play this on the kitchen speaker"). Do not search first, and never invent URIs.',
      input: z.object({
        query: z.string().min(1).max(200).optional().describe("What to play, in the user's words."),
        uri: spotifyUri.describe("Exact Spotify URI from a previous Spotify tool result. Use instead of query only when a result already identified the item."),
        type: z.enum(["track", "album", "artist", "playlist"]).optional().describe("Only when the user named the kind of item."),
        deviceName,
        spotifyDeviceId,
      }),
      risk: "write",
      untrustedOutput: true,
    },
    {
      execute: (input, ctx) => player.play(ctx.userId, { ...input, deviceId: input.spotifyDeviceId }, ctx.signal),
    },
  );

  registry.register(
    {
      ...base,
      id: "spotify.pause",
      title: "Pausing Spotify",
      description: 'Pause Spotify playback ("pause", "stop the music"). To resume, use spotify.play with no query.',
      input: z.object({ deviceName, spotifyDeviceId }),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (input, ctx) => player.pause(ctx.userId, { deviceName: input.deviceName, deviceId: input.spotifyDeviceId }, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.next",
      title: "Skipping track",
      description: 'Skip to the next track on Spotify ("skip this", "next song").',
      input: z.object({}),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (_input, ctx) => player.next(ctx.userId, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.previous",
      title: "Going back a track",
      description: 'Go back to the previous track on Spotify ("go back", "previous song"). To restart the current song instead, use spotify.seek with restart.',
      input: z.object({}),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (_input, ctx) => player.previous(ctx.userId, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.seek",
      title: "Seeking",
      description:
        'Jump within the current Spotify track. Use exactly one of: `position` for "go to 1:32" (m:ss or h:mm:ss), `offsetSeconds` for relative jumps ("forward 30 seconds" = 30, "back 10 seconds" = -10), or `restart: true` for "restart this song".',
      input: z
        .object({
          position: z.string().min(1).max(20).optional().describe('Target time like "1:32".'),
          positionMs: z.number().int().min(0).max(24 * 3600 * 1000).optional().describe("Target position in milliseconds."),
          offsetSeconds: z.number().min(-3600).max(3600).optional().describe("Relative jump in seconds; negative goes back."),
          restart: z.boolean().optional(),
        })
        .refine((v) => [v.position, v.positionMs, v.offsetSeconds, v.restart || undefined].filter((x) => x !== undefined).length === 1, "Give exactly one of position, positionMs, offsetSeconds or restart"),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (input, ctx) => player.seek(ctx.userId, input, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.set_volume",
      title: "Changing volume",
      description:
        'Set Spotify volume. `volumePercent` for an exact level ("set the volume to 40%", "mute" = 0). `change` for relative requests: "turn it down" = -10, "turn it up a lot" = +25, "down 10%" = -10. The server reads the current volume, clamps to 0–100, and checks the device supports remote volume.',
      input: z
        .object({
          volumePercent: z.number().int().min(0).max(100).optional(),
          change: z.number().int().min(-100).max(100).optional().describe("Relative change in percentage points."),
          deviceName,
          spotifyDeviceId,
        })
        .refine((v) => (v.volumePercent === undefined) !== (v.change === undefined), "Give exactly one of volumePercent or change"),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (input, ctx) => player.setVolume(ctx.userId, { ...input, deviceId: input.spotifyDeviceId }, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.set_shuffle",
      title: "Changing shuffle",
      description: 'Turn Spotify shuffle on or off ("turn shuffle on", "stop shuffling").',
      input: z.object({ enabled: z.boolean() }),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (input, ctx) => player.setShuffle(ctx.userId, input.enabled, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.set_repeat",
      title: "Changing repeat",
      description: 'Set Spotify repeat: "track" for "repeat this song", "context" for "repeat this playlist/album", "off" for "turn repeat off".',
      input: z.object({ mode: z.enum(["off", "track", "context"]) }),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (input, ctx) => player.setRepeat(ctx.userId, input.mode, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.search",
      title: "Searching Spotify",
      description:
        "Search the Spotify catalog and the user's playlists when the user wants to know what exists or choose between options (\"what albums does Laufey have?\"). Not needed to play something: spotify.play searches by itself.",
      input: z.object({
        query: z.string().min(1).max(200),
        types: z.array(z.enum(SEARCH_TYPES)).min(1).max(5).optional().describe("Defaults to track, artist, album, playlist."),
        limit: z.number().int().min(1).max(10).optional().describe("Results per type (default 5)."),
      }),
      risk: "read",
      untrustedOutput: true,
    },
    { execute: (input, ctx) => player.search(ctx.userId, input.query, input.types ?? ["track", "artist", "album", "playlist"], input.limit ?? 5, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.add_to_queue",
      title: "Adding to queue",
      description:
        'Add a song (or podcast episode) to the Spotify queue. Pass the user\'s words as `query` ("Espresso by Sabrina Carpenter"); for "add this song to the queue" first read the current item with spotify.get_playback_state and pass its uri.',
      input: z.object({
        query: z.string().min(1).max(200).optional(),
        uri: spotifyUri.describe("Track or episode URI from a previous Spotify tool result."),
        type: z.enum(["track", "episode"]).optional(),
      }),
      risk: "write",
      untrustedOutput: true,
    },
    { execute: (input, ctx) => player.addToQueue(ctx.userId, input, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.get_queue",
      title: "Checking the queue",
      description: 'What plays next on Spotify ("what\'s next?", "what\'s in my queue?").',
      input: z.object({ limit: z.number().int().min(1).max(10).optional().describe("How many upcoming items (default 5).") }),
      risk: "read",
      untrustedOutput: true,
    },
    { execute: (input, ctx) => player.queue(ctx.userId, input.limit ?? 5, ctx.signal) },
  );

  registry.register(
    {
      ...base,
      id: "spotify.list_devices",
      title: "Finding Spotify devices",
      description: "List Spotify Connect devices that are available now (phones, computers, speakers, TVs) with which one is active, volume, and whether they can be controlled.",
      input: z.object({}),
      risk: "read",
      untrustedOutput: false,
    },
    {
      async execute(_input, ctx) {
        const devices = await player.devices(ctx.userId, ctx.signal);
        return {
          devices,
          active: devices.find((d) => d.isActive)?.name ?? null,
          ...(devices.length ? {} : { note: "No devices are available. Spotify has to be open on a phone, computer or speaker." }),
        };
      },
    },
  );

  registry.register(
    {
      ...base,
      id: "spotify.transfer_playback",
      title: "Moving Spotify",
      description:
        'Move Spotify playback to another device ("switch Spotify to my computer", "move the music to the kitchen speaker"). Set play=true to make sure it starts playing there. If the user also names something to play, use spotify.play with deviceName instead.',
      input: z.object({ deviceName, spotifyDeviceId, play: z.boolean().optional() }).refine((v) => v.deviceName || v.spotifyDeviceId, "Give deviceName or spotifyDeviceId"),
      risk: "write",
      untrustedOutput: false,
    },
    { execute: (input, ctx) => player.transfer(ctx.userId, { deviceName: input.deviceName, deviceId: input.spotifyDeviceId, play: input.play }, ctx.signal) },
  );
}
