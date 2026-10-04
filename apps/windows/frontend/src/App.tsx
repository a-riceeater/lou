import type { ConnectionState } from "@lou/protocol";
import { useEffect, useState } from "react";
import { bridge } from "./bridge/bridge";
import { AppShell } from "./screens/AppShell";
import { Pairing } from "./screens/Pairing";
import { Palette } from "./screens/Palette";
import { useConnection } from "./stores/connection";

/** Two surfaces from one bundle: `#/palette` (floating assistant) and `#/app/...` (main window). */
export function App() {
  const [surface, setSurface] = useState(location.hash.startsWith("#/palette") ? "palette" : "app");
  const connection = useConnection();

  useEffect(() => {
    const onHash = () => setSurface(location.hash.startsWith("#/palette") ? "palette" : "app");
    window.addEventListener("hashchange", onHash);
    const off = bridge().on("connection.state", (s) => connection.set(s as ConnectionState));
    void bridge()
      .request<{ connection?: ConnectionState }>("app.info")
      .then((info) => info.connection && connection.set(info.connection))
      .catch(() => undefined);
    document.documentElement.dataset.surface = surface;
    return () => {
      window.removeEventListener("hashchange", onHash);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unpaired = connection.state.state === "unpaired" || connection.state.state === "revoked";

  if (surface === "palette") {
    if (unpaired) return <PaletteUnpaired />;
    return <Palette />;
  }
  if (unpaired) return <Pairing revoked={connection.state.state === "revoked"} />;
  return <AppShell />;
}

function PaletteUnpaired() {
  return (
    <div className="palette-root">
      <div className="panel" style={{ padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span style={{ font: "400 17px/24px var(--font-display)" }}>Connect this computer to your assistant first.</span>
        <button className="btn btn-primary" onClick={() => void bridge().request("window.show", { surface: "app" })}>
          Connect
        </button>
      </div>
    </div>
  );
}
