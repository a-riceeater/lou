import { useState } from "react";
import { pairingErrorMessage } from "../api/client";
import { bridge } from "../bridge/bridge";
import { Presence } from "../components/Presence";

/** First run: connect this computer to the user's own server with a one-time code. */
export function Pairing({ revoked }: { revoked?: boolean }) {
  const [serverUrl, setServerUrl] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("My PC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="pairing">
      <form
        className="pairing-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await bridge().request("pairing.complete", { serverUrl: serverUrl.trim(), pairingCode: code.trim(), name: name.trim() || "My PC" });
          } catch (err) {
            setError(pairingErrorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Presence phase={busy ? "thinking" : "idle"} />
        <h1 className="screen-title">{revoked ? "This computer was signed out" : "Connect to your assistant"}</h1>
        <p className="screen-sub">Run <kbd>lou pair</kbd> on your server, or use “Add a device” on another signed-in device.</p>
        <label className="field">
          <span>Server address</span>
          <input className="text-input" required placeholder="https://lou.example.com" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} inputMode="url" />
        </label>
        <label className="field">
          <span>Pairing code</span>
          <input className="text-input" required placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <label className="field">
          <span>Name for this computer</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 8 }}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
