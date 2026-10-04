import type { AccountView } from "@lou/protocol";
import { useState } from "react";
import { api, friendlyError } from "../api/client";
import { bridge } from "../bridge/bridge";
import { Empty, LoadError, relativeTime, useLoad } from "../components/ui";

const PROVIDER: Record<AccountView["provider"], string> = { google: "Gmail", instagram: "Instagram", mcp: "Connected service" };

function statusCopy(a: AccountView): { text: string; dot: string } {
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
  const [error, setError] = useState<string | null>(null);

  const connect = async (provider: "google" | "instagram") => {
    setError(null);
    try {
      const { authUrl } = await api.connectAccount(provider);
      await bridge().request("app.openExternal", { url: authUrl });
    } catch (err) {
      setError(friendlyError(err).message);
    }
  };

  const items = accounts.data?.items ?? [];
  const available = accounts.data?.available;

  return (
    <>
      <h1 className="screen-title">Accounts</h1>
      <p className="screen-sub">Services Lou can read from and act on. Sign-ins happen in your browser; Lou never sees your passwords.</p>

      <div className="inline-form" style={{ marginBottom: 8 }}>
        <button className="btn btn-primary" disabled={available && !available.google} onClick={() => void connect("google")}>
          Add Gmail
        </button>
        <button className="btn" disabled={available && !available.instagram} onClick={() => void connect("instagram")}>
          Add Instagram
        </button>
        <button className="btn" onClick={() => void accounts.reload()}>
          Refresh
        </button>
      </div>
      {available && (!available.google || !available.instagram) && (
        <p className="hint">{!available.google ? "Gmail" : "Instagram"} needs to be set up on your server first — see docs/INTEGRATIONS.md.</p>
      )}
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
                      {a.lastCheckedAt ? `, checked ${relativeTime(a.lastCheckedAt)}` : ""}
                    </div>
                  </div>
                </div>
                <div className="row-side">
                  {a.status === "needs_reauth" && a.provider !== "mcp" && (
                    <button className="btn btn-primary" onClick={() => void connect(a.provider as "google" | "instagram")}>
                      Reconnect
                    </button>
                  )}
                  {a.provider !== "mcp" && (
                    <button className="btn" onClick={async () => (await api.checkAccount(a.id).catch(() => undefined), void accounts.reload())}>
                      Check
                    </button>
                  )}
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
    </>
  );
}
