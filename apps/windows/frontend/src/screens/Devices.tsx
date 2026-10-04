import { useState } from "react";
import { api, friendlyError } from "../api/client";
import { LoadError, relativeTime, useLoad } from "../components/ui";

const CAPABILITY: Record<string, string> = {
  open_app: "apps",
  open_file: "files",
  open_url: "links",
  search_files: "file search",
  clipboard_read: "clipboard",
  clipboard_write: "clipboard",
  active_window: "windows",
  ui_automation: "app control",
  notifications: "notifications",
};

export function Devices() {
  const devices = useLoad(() => api.devices());
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <h1 className="screen-title">Devices</h1>
      <p className="screen-sub">Computers and phones signed in to your assistant. Revoking one signs it out immediately.</p>

      <div className="inline-form">
        <button
          className="btn btn-primary"
          onClick={async () => {
            try {
              setCode(await api.pairingCode());
            } catch (err) {
              setError(friendlyError(err).message);
            }
          }}
        >
          Add a device
        </button>
      </div>
      {code && (
        <div style={{ marginTop: 16 }}>
          <div className="code-display">{code.code}</div>
          <p className="hint">Enter this code on the new device. It works once and expires {relativeTime(code.expiresAt)}.</p>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      {devices.error ? (
        <LoadError message={devices.error} onRetry={() => void devices.reload()} />
      ) : (
        <ul className="list" style={{ marginTop: 16 }}>
          {devices.data?.map((d) => {
            const caps = [...new Set(d.capabilities.map((c) => CAPABILITY[c] ?? c))];
            return (
              <li key={d.id} className="row">
                <div className="row-lead">
                  <span className={`dot ${d.status === "revoked" ? "bad" : d.online ? "on" : ""}`} />
                  <div>
                    <div className="row-title">
                      {d.name} {d.current && <span className="tag">This device</span>}
                    </div>
                    <div className="row-sub">
                      {d.status === "revoked" ? "Revoked" : d.online ? "Online" : `Last seen ${relativeTime(d.lastSeenAt)}`}
                      {caps.length > 0 && d.status !== "revoked" ? ` — ${caps.join(", ")}` : ""}
                    </div>
                  </div>
                </div>
                <div className="row-side">
                  {d.status === "active" && !d.current && (
                    <button className="btn btn-danger" onClick={async () => (await api.revokeDevice(d.id).catch(() => undefined), void devices.reload())}>
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
