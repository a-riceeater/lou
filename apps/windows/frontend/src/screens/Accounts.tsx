import type { AccountView } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";
import { GmailConnectionDialog } from "../components/GmailConnectionDialog";
import { GmailSetupDialog } from "../components/GmailSetupDialog";
import { SpotifySection } from "../components/SpotifySection";
import { Empty, LoadError, relativeTime, useLoad } from "../components/ui";

const PROVIDER: Record<AccountView["provider"], string> = { google: "Gmail", instagram: "Instagram", mcp: "Connected service", spotify: "Spotify" };

function statusCopy(a: AccountView): { text: string; dot: string } {
  if (a.connectionMethod === "appscript") {
    if (a.status === "needs_reauth") return { text: "Authorization required", dot: "warn" };
    if (a.syncState === "stale") return { text: "Script not running / stale connection", dot: "warn" };
    if (a.syncState === "syncing") return { text: "Syncing", dot: "on" };
  }
  switch (a.status) {
    case "connected":
      return { text: "Connected", dot: "on" };
    case "needs_reauth":
      return { text: "Needs you to sign in again", dot: "warn" };
    case "error":
      return { text: a.lastError ?? "Not responding", dot: "bad" };
    default:
      return { text: "Not connected", dot: "" };
  }
}

export function Accounts() {
  const accounts = useLoad(() => api.accounts());
  const gmailSetup = useLoad(() => api.googleSetup());
  const [connectionDialog, setConnectionDialog] = useState(false);
  const [resetId, setResetId] = useState<string>();
  const [checking, setChecking] = useState<string>();
  useEffect(() => { const timer = setInterval(() => void accounts.reload(), 15_000); return () => clearInterval(timer); }, [accounts.reload]);
  const [gmailDialog, setGmailDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (provider: "google" | "instagram") => {
    setError(null);
    setGmailDialog(false);
    try {
      const { authUrl } = await api.connectAccount(provider);
      await bridge().request("app.openExternal", { url: authUrl });
    } catch (err) {
      setError(friendlyError(err).message);
    }
  };

  // Spotify has its own section below (setup, device, Now Playing).
  const items = (accounts.data?.items ?? []).filter((a) => a.provider !== "spotify");
  const available = accounts.data?.available;
  const gmailReady = available ? available.google : true;
  // Without a Google OAuth client yet, "Add Gmail" walks through setting one up.
  const addGmail = () => { setResetId(undefined); setConnectionDialog(true); };

  return (
    <>
      <h1 className="screen-title">Accounts</h1>
      <p className="screen-sub">Services Lou can read from and act on. Sign-ins happen in your browser; Lou never sees your passwords.</p>

      <div className="inline-form" style={{ marginBottom: 8 }}>
        <button className="btn btn-primary" onClick={addGmail}>
          Add Gmail
        </button>
        {gmailReady && gmailSetup.data?.redirectUri && (
          <button className="btn" onClick={() => setGmailDialog(true)}>
            Gmail setup
          </button>
        )}
        <button className="btn" disabled={available && !available.instagram} onClick={() => void connect("instagram")}>
          Add Instagram
        </button>
        <button className="btn" onClick={() => void accounts.reload()}>
          Refresh
        </button>
      </div>
      {available && !available.google && <p className="hint">Google sign-in needs a one-time Google Cloud setup. Apps Script is also available through Add Gmail.</p>}
      {available && !available.instagram && <p className="hint">Instagram needs to be set up on your server first — see docs/INTEGRATIONS.md.</p>}
      {error && <p className="error-text">{error}</p>}

      {accounts.error ? (
        <LoadError message={accounts.error} onRetry={() => void accounts.reload()} />
      ) : !accounts.loading && items.length === 0 ? (
        <Empty title="No accounts yet">Add Gmail to let Lou find and reply to email.</Empty>
      ) : (
        <ul className="list" style={{ marginTop: 16 }}>
          {items.map((a) => {
            const st = statusCopy(a);
            return (
              <li key={a.id} className="row">
                <div className="row-lead">
                  <span className={`dot ${st.dot}`} />
                  <div>
                    <div className="row-title">{a.provider === "mcp" ? a.displayName : (a.address ?? a.displayName)}</div>
                    <div className="row-sub">
                      {PROVIDER[a.provider]} — {st.text}
                      {a.connectionMethod === "appscript" ? ` · ${a.status === "connected" ? "Connected via" : "via"} Apps Script · Last synced ${relativeTime(a.lastSyncedAt)}` : a.lastCheckedAt ? `, checked ${relativeTime(a.lastCheckedAt)}` : ""}
                    </div>
                  </div>
                </div>
                <div className="row-side">
                  {a.status === "needs_reauth" && a.provider !== "mcp" && a.connectionMethod !== "appscript" && (
                    <button className="btn btn-primary" onClick={() => void connect(a.provider as "google" | "instagram")}>
                      Reconnect
                    </button>
                  )}
                  {a.provider !== "mcp" && (
                    <button className="btn" disabled={checking === a.id} onClick={async () => { setChecking(a.id); try { await api.checkAccount(a.id); } catch (err) { setError(friendlyError(err).message); } finally { setChecking(undefined); void accounts.reload(); } }}>
                      {checking === a.id ? "Waiting for script…" : a.connectionMethod === "appscript" ? "Test connection" : "Check"}
                    </button>
                  )}
                  {a.connectionMethod === "appscript" && <button className="btn" onClick={() => { setResetId(a.id); setConnectionDialog(true); }}>Regenerate script</button>}
                  {a.provider !== "mcp" && (
                    <button className="btn btn-danger" onClick={async () => (await api.disconnectAccount(a.id).catch(() => undefined), void accounts.reload())}>
                      Disconnect
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {connectionDialog && <GmailConnectionDialog resetId={resetId} onClose={() => setConnectionDialog(false)} onChanged={accounts.reload} onOAuth={() => { setConnectionDialog(false); if (gmailReady) void connect("google"); else setGmailDialog(true); }} />}
      {gmailDialog && gmailSetup.data?.redirectUri && (
        <GmailSetupDialog
          status={gmailSetup.data}
          onClose={() => setGmailDialog(false)}
          onSaved={(next) => (gmailSetup.setData(next), void accounts.reload())}
          onConnect={() => void connect("google")}
        />
      )}
      {gmailDialog && gmailSetup.error && <p className="error-text">{gmailSetup.error}</p>}

      <h2 className="section-title">Music</h2>
      <SpotifySection />
    </>
  );
}
