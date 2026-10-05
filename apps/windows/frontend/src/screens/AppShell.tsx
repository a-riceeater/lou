import type { ServerMessage } from "@lou/protocol";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { bridge } from "../bridge/bridge";
import { NowPlaying } from "../components/NowPlaying";
import { Presence } from "../components/Presence";
import { useConnection } from "../stores/connection";
import "../styles/app.css";
import { Accounts } from "./Accounts";
import { Devices } from "./Devices";
import { History } from "./History";
import { Inbox } from "./Inbox";
import { Memory } from "./Memory";
import { Settings } from "./Settings";
import { Skills } from "./Skills";

const ROUTES = {
  inbox: { label: "Inbox", component: Inbox },
  history: { label: "History", component: History },
  skills: { label: "Skills", component: Skills },
  memory: { label: "Memory", component: Memory },
  accounts: { label: "Accounts", component: Accounts },
  devices: { label: "Devices", component: Devices },
  settings: { label: "Settings", component: Settings },
} as const;
type Route = keyof typeof ROUTES;

function routeFromHash(): Route {
  const r = location.hash.replace(/^#\/app\/?/, "") as Route;
  return r in ROUTES ? r : "inbox";
}

export function AppShell() {
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [pending, setPending] = useState(0);
  const connection = useConnection((s) => s.state);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    const offShown = bridge().on("window.shown", (p) => {
      const r = (p as { route?: string })?.route;
      if (r && r in ROUTES) navigate(r as Route);
    });
    return () => {
      window.removeEventListener("hashchange", onHash);
      offShown();
    };
  }, []);

  useEffect(() => {
    const refresh = () => void api.approvals("pending").then((a) => setPending(a.length)).catch(() => undefined);
    refresh();
    return bridge().on("server.message", (f) => {
      const t = (f as ServerMessage).type;
      if (t === "approval.requested" || t === "approval.resolved") refresh();
    });
  }, []);

  const navigate = (r: Route) => {
    location.hash = `#/app/${r}`;
    setRoute(r);
  };

  const Screen = ROUTES[route].component;
  const conn = connection.state;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Sections">
        <div className="wordmark">
          <Presence phase={conn === "online" ? "idle" : conn === "connecting" ? "thinking" : "failure"} />
          Lou
        </div>
        {(Object.keys(ROUTES) as Route[]).map((r) => (
          <button key={r} className="nav-item" aria-current={r === route ? "page" : undefined} onClick={() => navigate(r)}>
            {ROUTES[r].label}
            {r === "inbox" && pending > 0 && <span className="nav-count">{pending}</span>}
          </button>
        ))}
        <div className="spacer" />
        <NowPlaying />
        <div className="connection" title={connection.error ?? undefined}>
          <span className={`dot ${conn === "online" ? "on" : conn === "connecting" ? "warn" : "bad"}`} />
          {conn === "online" ? "Connected" : conn === "connecting" ? "Connecting…" : "Offline — retrying"}
        </div>
      </nav>
      <main className="content">
        <div className="content-inner" key={route}>
          <Screen />
        </div>
      </main>
    </div>
  );
}
