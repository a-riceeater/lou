import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setBridge } from "./bridge/bridge";
import { DevBridge } from "./bridge/dev";
import { NativeBridge } from "./bridge/native";
import "./styles/global.css";

setBridge(NativeBridge.available() ? new NativeBridge(window.chrome!.webview!) : new DevBridge());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
