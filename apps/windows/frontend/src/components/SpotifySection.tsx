import type { SpotifyStatus } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";
import { SpotifyIcon } from "./SpotifyIcon";
import { SpotifySetupDialog } from "./SpotifySetupDialog";
import { useLoad } from "./ui";

const COPY: Record<SpotifyStatus["state"], { text: string; dot: string }> = {
  not_configured: { text: "Not set up on your server yet", dot: "" },
  disconnected: { text: "Not connected", dot: "" },
  connected: { text: "Connected", dot: "on" },
  needs_reauth: { text: "Needs you to sign in again", dot: "warn" },
  unavailable: { text: "Spotify isn't responding", dot: "bad" },
};

/** Spotify's row in Accounts: setup, connect/reconnect, disconnect, and the active device. */
export function SpotifySection() {
  const status = useLoad(() => api.spotify());
  const [device, setDevice] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;

  // After the browser sign-in, pick up the new connection without a manual refresh.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      const next = await api.spotify().catch(() => undefined);
      if (next) status.setData(next);
      if (next?.state === "connected" || Date.now() - started > 3 * 60_000) setWaiting(false);
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (s?.state !== "connected") return setDevice(null);
    void api
      .spotifyPlayer()
      .then((p) => setDevice(p.device?.name ?? null))
      .catch(() => setDevice(null));
  }, [s?.state, s?.account?.id]);

  const connect = async () => {
    setError(null);
    setDialog(false);
    try {
      const { authUrl } = await api.connectAccount("spotify");
      await bridge().request("app.openExternal", { url: authUrl });
      setWaiting(true);
    } catch (err) {
      setError(friendlyError(err).message);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(friendlyError(err).message);
    }
    await status.reload();
  };

  if (status.error) return <p className="error-text">{status.error}</p>;
  if (!s) return null;
  const st = COPY[s.state];
  const account = s.account;

  return (
    <section aria-label="Spotify">
      <div className="row integration-row">
        <div className="row-lead">
          <SpotifyIcon size={28} title="Spotify" />
          <div>
            <div className="row-title">Spotify</div>
            <div className="row-sub">
              <span className={`dot inline ${st.dot}`} />
              {s.state === "connected" && account ? `Connected as ${account.displayName}` : st.text}
              {s.state === "connected" && device ? ` · Playing on ${device}` : ""}
              {waiting && s.state !== "connected" ? " · Finish signing in in your browser…" : ""}
            </div>
          </div>
        </div>
        <div className="row-side">
          {s.state === "not_configured" && (
            <button className="btn btn-primary" onClick={() => setDialog(true)}>
              Set up
            </button>
          )}
          {s.state === "disconnected" && (
            <>
              <button className="btn" onClick={() => setDialog(true)}>
                Setup
              </button>
              <button className="btn btn-primary" onClick={() => void connect()}>
                Connect Spotify
              </button>
            </>
          )}
          {s.state === "needs_reauth" && (
            <button className="btn btn-primary" onClick={() => void connect()}>
              Reconnect
            </button>
          )}
          {(s.state === "connected" || s.state === "unavailable") && account && (
            <button className="btn" onClick={() => void run(() => api.checkAccount(account.id))}>
              Check
            </button>
          )}
          {account && s.state !== "disconnected" && s.state !== "not_configured" && (
            <button className="btn btn-danger" onClick={() => void run(() => api.disconnectAccount(account.id))}>
              Disconnect
            </button>
          )}
        </div>
      </div>
      {s.state === "needs_reauth" && s.lastError && <p className="hint">{s.lastError}</p>}
      {s.state === "unavailable" && s.lastError && <p className="hint">{s.lastError}</p>}
      {error && <p className="error-text">{error}</p>}
      {dialog && <SpotifySetupDialog status={s} onClose={() => setDialog(false)} onSaved={(next) => status.setData(next)} onConnect={() => void connect()} />}
    </section>
  );
}
