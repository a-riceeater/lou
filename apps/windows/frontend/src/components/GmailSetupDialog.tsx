import type { GoogleSetupStatus } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";

const GMAIL_API_URL = "https://console.cloud.google.com/apis/library/gmail.googleapis.com";
const CONSENT_URL = "https://console.cloud.google.com/apis/credentials/consent";
const CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";

/**
 * Guided, one-time setup of the Google Cloud OAuth client Lou signs in to Gmail
 * with (docs/INTEGRATIONS.md → Gmail). The redirect URI comes from the server so
 * it always matches exactly. Credentials typed here go straight to the server,
 * which verifies them with Google and stores the secret encrypted; the UI never
 * reads it back.
 */
export function GmailSetupDialog({ status, onClose, onSaved, onConnect }: { status: GoogleSetupStatus; onClose(): void; onSaved(status: GoogleSetupStatus): void; onConnect(): void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromEnv = status.configSource === "env";
  const canConnect = status.configSource !== null;
  const entering = clientId.trim() !== "" || clientSecret.trim() !== "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = (url: string) => void bridge().request("app.openExternal", { url });

  const copy = async () => {
    try {
      await bridge().request("clipboard.write", { text: status.redirectUri });
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Couldn't copy. Select the address and copy it manually.");
    }
  };

  // Google offers the client as a JSON download; pasting it fills both fields.
  const changeClientId = (value: string) => {
    if (!value.trim().startsWith("{")) return setClientId(value);
    try {
      const json = JSON.parse(value) as { web?: { client_id?: string; client_secret?: string }; installed?: unknown };
      if (json.installed) return setError("That's a Desktop app client. Create one of type Web application instead.");
      if (!json.web?.client_id) throw new Error("no client");
      setError(null);
      setClientId(json.web.client_id);
      setClientSecret(json.web.client_secret ?? "");
    } catch {
      setClientId(value);
    }
  };

  const submit = async () => {
    setError(null);
    if (!entering) return onConnect();
    if (!clientId.trim() || !clientSecret.trim()) return setError("Enter both the Client ID and the Client secret.");
    setBusy(true);
    try {
      const saved = await api.saveGoogleApp(clientId.trim(), clientSecret.trim());
      setClientSecret("");
      onSaved(saved);
      onConnect();
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="gmail-setup-title">
        <div className="dialog-head">
          <h2 id="gmail-setup-title">Set up Gmail</h2>
        </div>
        <p className="dialog-sub">
          Lou reads and drafts email through Google's official Gmail API, and never sends without your approval. It needs a Google Cloud sign-in app of your own; this takes about five minutes and only happens once.
        </p>

        <ol className="setup-steps">
          <li>
            <strong>Enable the Gmail API.</strong> Create a Google Cloud project (or pick an existing one), then choose <em>Enable</em> on the Gmail API page.
            <div>
              <button className="btn btn-link" onClick={() => open(GMAIL_API_URL)}>
                Open the Gmail API in Google Cloud
              </button>
            </div>
          </li>
          <li>
            <strong>Set up the OAuth consent screen.</strong> Choose <em>External</em>, then add these scopes:
            <div className="scope-list">
              {status.scopes.map((s) => (
                <code key={s}>{s.replace("https://www.googleapis.com/auth/", "")}</code>
              ))}
            </div>
            While the app is in <em>Testing</em>, add every Google account you'll connect as a <em>test user</em>.
            <div>
              <button className="btn btn-link" onClick={() => open(CONSENT_URL)}>
                Open the OAuth consent screen
              </button>
            </div>
          </li>
          <li>
            <strong>Create an OAuth client ID</strong> of type <em>Web application</em>, and add this <em>Authorized redirect URI</em> exactly as shown:
            <div className="copy-field">
              <code aria-label="Redirect URI">{status.redirectUri}</code>
              <button className="btn" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div>
              <button className="btn btn-link" onClick={() => open(CREDENTIALS_URL)}>
                Open Credentials
              </button>
            </div>
          </li>
          <li>
            <strong>Paste the client's credentials</strong> from the dialog Google shows after you create it. You can also paste the downloaded JSON file into Client ID.
            {fromEnv ? (
              <p className="hint">Already configured on your server (Client ID {mask(status.clientId)}).</p>
            ) : (
              <>
                {status.configSource === "server" && <p className="hint">Saved (Client ID {mask(status.clientId)}). Enter new values only to replace them.</p>}
                <label className="field">
                  <span>Client ID</span>
                  <input className="text-input" value={clientId} onChange={(e) => changeClientId(e.target.value)} placeholder="….apps.googleusercontent.com" autoComplete="off" spellCheck={false} autoFocus={!canConnect} />
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
            {busy ? "Checking…" : entering ? "Save and add Gmail" : "Add Gmail"}
          </button>
        </div>
      </div>
    </div>
  );
}

function mask(id: string | null): string {
  return id ? `…${id.split(".")[0]!.slice(-6)}` : "unknown";
}
