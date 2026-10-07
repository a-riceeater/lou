import type { AccountView } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";
import { relativeTime } from "./ui";

export function GmailConnectionDialog({ onClose, onOAuth, onChanged, resetId }: { onClose(): void; onOAuth(): void; onChanged(): void; resetId?: string }) {
  const [installation, setInstallation] = useState<{ accountId: string; script: string }>();
  const [account, setAccount] = useState<AccountView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  useEffect(() => {
    if (!installation) return;
    let active = true;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const result = await api.accounts();
        if (active) {
          const next = result.items.find(item => item.id === installation.accountId);
          setAccount(next);
          if (next?.status === "connected" && next.lastSyncedAt) onChanged();
        }
      } catch (err) { if (active) setError(friendlyError(err).message); }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [installation, onChanged]);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try { setInstallation(await api.createGmailScript(resetId)); onChanged(); }
    catch (err) { setError(friendlyError(err).message); }
    finally { setBusy(false); }
  };
  const connected = account?.status === "connected" && !!account.lastSyncedAt;
  return <div className="dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="dialog gmail-script-dialog" role="dialog" aria-modal="true" aria-labelledby="gmail-connection-title">
      <div className="dialog-head"><h2 id="gmail-connection-title">Connect Gmail</h2></div>
      {!installation ? <>
        {!resetId && <><p className="dialog-sub">Choose how to connect your Gmail account. Google sign-in is preferred when available.</p>
          <button className="btn btn-primary" onClick={onOAuth}>Sign in with Google</button>
          <p className="hint">Can’t use Google OAuth?</p></>}
        <p className="dialog-sub">Use a script running in your own Google account if your Workspace administrator permits Apps Script and Gmail access.</p>
        {resetId && <p className="hint">Resetting immediately revokes the old script. Paste the new script into your project and run setupLou again.</p>}
        <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>{busy ? "Creating script…" : resetId ? "Regenerate script / reset connection" : "Connect using Google Apps Script"}</button>
      </> : connected ? <div role="status">
        <h3>Connected</h3><p>{account.address ?? account.displayName}</p>
        <p className="hint">Connected via Apps Script · Last synced {relativeTime(account.lastSyncedAt)}</p>
      </div> : <>
        <ol className="setup-steps">
          <li><strong>Create script.</strong> Open Google Apps Script and create a new project.<div><button className="btn btn-link" onClick={() => void bridge().request("app.openExternal", { url: "https://script.google.com" })}>Open Google Apps Script</button></div></li>
          <li><strong>Paste.</strong> Copy this script and replace everything in <code>Code.gs</code>.<p className="hint">Keep this script private. It contains a credential for this Gmail integration.</p>
            <button className="btn btn-primary" onClick={async () => { try { await bridge().request("clipboard.write", { text: installation.script }); setCopied(true); } catch (err) { setError(friendlyError(err).message); } }}>{copied ? "Copied Script" : "Copy Script"}</button>
            <pre className="gmail-script-code" tabIndex={0} aria-label="Generated Apps Script"><code>{installation.script}</code></pre>
          </li>
          <li><strong>Run setup.</strong> Save, select <code>setupLou</code>, and press Run. Google will ask you to approve Gmail access. If your administrator denies access, stop setup.</li>
          <li><strong>Waiting for connection.</strong> Lou checks automatically. Mail and commands usually sync within about one minute.</li>
        </ol>
        <p role="status" className="hint">{account?.lastError ?? (account?.syncState === "stale" ? "Script not running. Open Apps Script and run setupLou again." : account?.syncState === "syncing" ? "Syncing…" : "Waiting for you to run setupLou…")}</p>
      </>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="btn" onClick={onClose}>{connected ? "Done" : "Close"}</button></div>
    </div>
  </div>;
}
