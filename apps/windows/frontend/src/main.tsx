import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setBridge } from "./bridge/bridge";
import { DevBridge } from "./bridge/dev";
import { NativeBridge } from "./bridge/native";
import "./styles/global.css";

const native = NativeBridge.available();
if (native) setBridge(new NativeBridge(window.chrome!.webview!));
else if (import.meta.env.MODE === "demo") setBridge(new (await import("./bridge/demo")).DemoBridge());
else setBridge(new DevBridge());
// In the Windows app the window itself is the panel (native acrylic, rounded corners, shadow).
if (native) document.documentElement.dataset.native = "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
