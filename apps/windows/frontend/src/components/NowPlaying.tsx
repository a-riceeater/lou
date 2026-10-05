import type { ServerMessage, SpotifyPlayerView } from "@lou/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { bridge } from "../bridge/bridge";
import { SpotifyIcon } from "./SpotifyIcon";

/** Reconcile with Spotify this often; progress is interpolated locally in between. */
export const POLL_PLAYING_MS = 15_000;
export const POLL_IDLE_MS = 45_000;
/** Spotify applies commands asynchronously; read back shortly after one. */
const AFTER_COMMAND_MS = 600;

type Action = "play" | "pause" | "next" | "previous";

/**
 * A small remote for Spotify Connect: what's playing, where, and basic controls.
 * It never plays audio itself. Polling is slow and pauses while the window is
 * hidden; it refreshes right after its own commands and after Lou finishes a run.
 */
export function NowPlaying() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<{ view: SpotifyPlayerView; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const checkStatus = useCallback(async () => {
    const status = await api.spotify().catch(() => undefined);
    setConnected(status?.state === "connected");
    if (status?.state !== "connected") setState(null);
    return status?.state === "connected";
  }, []);

  const refresh = useCallback(async () => {
    clearTimeout(pollTimer.current);
    try {
      const view = await api.spotifyPlayer();
      setState({ view, at: Date.now() });
      schedule(view.isPlaying ? POLL_PLAYING_MS : POLL_IDLE_MS);
    } catch {
      // Lost access (disconnected/revoked): hide until the status says otherwise.
      setState(null);
      if (await checkStatus()) schedule(POLL_IDLE_MS);
    }
    function schedule(ms: number) {
      clearTimeout(pollTimer.current);
      pollTimer.current = setTimeout(() => {
        if (document.hidden) return schedule(ms);
        void refresh();
      }, ms);
    }
  }, [checkStatus]);

  useEffect(() => {
    const sync = async () => {
      if (await checkStatus()) await refresh();
    };
    void sync();
    const offMessage = bridge().on("server.message", (frame) => {
      if ((frame as ServerMessage).type !== "agent.completed") return;
      setTimeout(() => void sync(), AFTER_COMMAND_MS);
    });
    const offShown = bridge().on("window.shown", () => void sync());
    return () => {
      offMessage();
      offShown();
      clearTimeout(pollTimer.current);
      clearTimeout(endTimer.current);
    };
  }, [checkStatus, refresh]);

  const view = state?.view;
  const playing = !!view?.isPlaying && !!view.item;

  // Interpolate progress once a second while playing (not every frame).
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playing]);

  const duration = view?.item?.durationMs ?? 0;
  const progress = view ? Math.min(duration, view.progressMs + (playing ? Math.max(0, now - state!.at) : 0)) : 0;

  // When the track should have ended, reconcile once instead of waiting for the next poll.
  useEffect(() => {
    clearTimeout(endTimer.current);
    if (!playing || !duration) return;
    const remaining = duration - (view!.progressMs + (Date.now() - state!.at));
    endTimer.current = setTimeout(() => void refresh(), Math.max(0, remaining) + 1500);
  }, [state, playing, duration, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: Action) => {
    if (!view) return;
    setBusy(true);
    if (action === "play" || action === "pause") setState((s) => (s ? { view: { ...s.view, isPlaying: action === "play", progressMs: progress }, at: Date.now() } : s));
    try {
      await api.spotifyControl(action);
    } catch {
      // The read-back below shows the real state.
    } finally {
      setBusy(false);
      setTimeout(() => void refresh(), AFTER_COMMAND_MS);
    }
  };

  if (!connected || !view?.active || !view.item) return null;
  const item = view.item;
  const pct = duration ? (progress / duration) * 100 : 0;

  return (
    <div className="now-playing" aria-label="Now playing on Spotify">
      <div className="np-main">
        {item.imageUrl ? <img className="np-art" src={item.imageUrl} alt="" /> : <div className="np-art" />}
        <div className="np-text">
          <div className="np-title" title={item.name}>
            {item.name}
          </div>
          <div className="np-sub" title={view.device ? `${item.artists.join(", ")} · ${view.device.name}` : undefined}>
            {item.artists.join(", ")}
          </div>
        </div>
      </div>
      <div className="np-progress" role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={Math.round(duration / 1000)} aria-valuenow={Math.round(progress / 1000)}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="np-controls">
        <button className="np-btn" aria-label="Open in Spotify" title="Open in Spotify" disabled={!item.url} onClick={() => item.url && void bridge().request("app.openExternal", { url: item.url })}>
          <SpotifyIcon size={15} />
        </button>
        <div className="np-transport">
          <button className="np-btn" aria-label="Previous track" disabled={busy} onClick={() => void act("previous")}>
            <Glyph d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </button>
          <button className="np-btn np-play" aria-label={view.isPlaying ? "Pause" : "Play"} disabled={busy} onClick={() => void act(view.isPlaying ? "pause" : "play")}>
            <Glyph d={view.isPlaying ? "M6 5h4v14H6zm8 0h4v14h-4z" : "M8 5v14l11-7z"} />
          </button>
          <button className="np-btn" aria-label="Next track" disabled={busy} onClick={() => void act("next")}>
            <Glyph d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
          </button>
        </div>
        <span className="np-balance" aria-hidden="true" />
      </div>
    </div>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}
