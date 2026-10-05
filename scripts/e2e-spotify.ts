/**
 * Optional live check against the REAL Spotify Web API, using the Spotify
 * account already connected in your local Lou (Accounts → Spotify). Never runs
 * in `npm test`; it only does anything when explicitly enabled:
 *
 *   LOU_SPOTIFY_E2E=1 npx tsx --env-file=apps/server/.env scripts/e2e-spotify.ts
 *
 * Read-only by default: forces a token refresh, then reads the player, devices,
 * queue and search. With LOU_SPOTIFY_E2E_PLAYBACK=1 and something playing, it
 * also pauses and resumes once (restoring the previous state).
 */
import { loadConfig } from "../apps/server/src/config";
import { createServices } from "../apps/server/src/container";
import { createLogger } from "../apps/server/src/logger";

if (process.env.LOU_SPOTIFY_E2E !== "1") {
  console.log("Skipped: set LOU_SPOTIFY_E2E=1 to run the live Spotify check.");
  process.exit(0);
}

const config = loadConfig();
// Not started: no pollers, MCP servers or model providers are touched.
const services = createServices(config, createLogger("warn", false));
const userId = services.owner.id;
const step = (label: string, detail?: unknown) => console.log(`✓ ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);

try {
  const status = services.spotify.status(userId);
  if (status.state !== "connected" || !status.account) throw new Error(`Spotify is ${status.state}; connect it in Lou → Accounts first.`);
  step("connected", `${status.account.displayName} (redirect ${status.redirectUri})`);

  await services.integrations.forceRefresh(status.account.id);
  step("token refresh");

  const player = services.spotifyPlayer;
  const state = await player.playback(userId);
  step("playback state", state.item ? `${state.isPlaying ? "playing" : "paused"} ${state.item.name} on ${state.device?.name}` : "nothing active");
  const devices = await player.devices(userId);
  step("devices", devices.map((d) => `${d.name} (${d.type}${d.isActive ? ", active" : ""}${d.isRestricted ? ", restricted" : ""})`));
  if (state.device) step("queue", (await player.queue(userId, 3)).upNext.map((i) => i.name));
  const search = await player.search(userId, "Bohemian Rhapsody", ["track"], 3);
  step("search", (search.tracks ?? []).map((t) => `${t.name} — ${t.by}`));

  if (process.env.LOU_SPOTIFY_E2E_PLAYBACK === "1") {
    if (!state.isPlaying) {
      console.log("· playback check skipped: nothing is playing");
    } else {
      await player.pause(userId);
      await new Promise((r) => setTimeout(r, 1500));
      step("paused", (await player.playback(userId)).isPlaying === false);
      await player.play(userId, {});
      step("resumed");
    }
  }
  console.log("Live Spotify check passed.");
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  services.db.$client.close();
}
