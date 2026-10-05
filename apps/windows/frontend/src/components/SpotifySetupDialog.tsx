import type { SpotifyStatus } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";
import { SpotifyIcon } from "./SpotifyIcon";

const DASHBOARD_URL = "https://developer.spotify.com/dashboard";

/**
 * Guided, one-time setup of the Spotify developer app Lou needs. The redirect
 * URI comes from the server so it always matches exactly. Credentials typed here
 * go straight to the server, which verifies them with Spotify and stores the
 * secret encrypted; the UI never reads it back.
 */
export function SpotifySetupDialog({ status, onClose, onSaved, onConnect }: { status: SpotifyStatus; onClose(): void; onSaved(status: SpotifyStatus): void; onConnect(): void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromEnv = status.configSource === "env";
  const entering = clientId.trim() !== "" || clientSecret.trim() !== "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await bridge().request("clipboard.write", { text: status.redirectUri });
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Couldn't copy. Select the address and copy it manually.");
    }
  };

  const submit = async () => {
    setError(null);
    if (!entering) return onConnect();
    if (!clientId.trim() || !clientSecret.trim()) return setError("Enter both the Client ID and the Client secret.");
    setBusy(true);
    try {
      const saved = await api.saveSpotifyApp(clientId.trim(), clientSecret.trim());
      setClientSecret("");
      onSaved(saved);
      onConnect();
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const canConnect = status.configSource !== null;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="spotify-setup-title">
        <div className="dialog-head">
          <SpotifyIcon size={28} />
          <h2 id="spotify-setup-title">Set up Spotify</h2>
        </div>
        <p className="dialog-sub">Lou controls Spotify on your phone, computer and speakers through Spotify's official API. It needs a Spotify developer app; this takes about two minutes.</p>

        <ol className="setup-steps">
          <li>
            <strong>Create an app</strong> in the Spotify Developer Dashboard. Name it “Lou” and select <em>Web API</em> when asked which APIs you'll use.
            <div>
              <button className="btn btn-link" onClick={() => void bridge().request("app.openExternal", { url: DASHBOARD_URL })}>
                Open Spotify Developer Dashboard
              </button>
            </div>
          </li>
          <li>
            <strong>Add this Redirect URI</strong> to the app, exactly as shown:
            <div className="copy-field">
              <code aria-label="Redirect URI">{status.redirectUri}</code>
              <button className="btn" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </li>
          <li>
            <strong>Add your Spotify account</strong> under <em>User Management</em>. Apps in Development Mode work for up to five listed accounts, and the app owner needs Spotify Premium.
          </li>
          <li>
            <strong>Paste the app's credentials</strong> from its <em>Basic Information</em> page.
            {fromEnv ? (
              <p className="hint">Already configured on your server (Client ID {mask(status.clientId)}).</p>
            ) : (
              <>
                {status.configSource === "server" && <p className="hint">Saved (Client ID {mask(status.clientId)}). Enter new values only to replace them.</p>}
                <label className="field">
                  <span>Client ID</span>
                  <input className="text-input" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} autoFocus={!canConnect} />
                </label>
                <label className="field">
                  <span>Client secret</span>
                  <input className="text-input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              </>
            )}
          </li>
        </ol>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || (!entering && !canConnect)} onClick={() => void submit()}>
            {busy ? "Checking…" : entering ? "Save and connect" : "Connect Spotify"}
          </button>
        </div>
      </div>
    </div>
  );
}

function mask(id: string | null): string {
  return id ? `…${id.slice(-4)}` : "unknown";
}
