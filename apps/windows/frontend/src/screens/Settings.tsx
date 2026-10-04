import type { SettingsView } from "@lou/protocol";
import { api } from "../api/client";
import { bridge } from "../bridge/bridge";
import { LoadError, Toggle, useLoad } from "../components/ui";

/** Emergency controls work without the agent (SECURITY.md §12). */
const CONTROLS: Array<{ key: keyof SettingsView; title: string; detail: string; danger?: boolean }> = [
  { key: "agentPaused", title: "Pause Lou", detail: "Stop all new requests and actions.", danger: true },
  { key: "writeToolsDisabled", title: "Turn off actions", detail: "Lou can still read and answer, but can't send or change anything.", danger: true },
  { key: "deviceControlDisabled", title: "Turn off computer control", detail: "Lou can't open apps, files or use windows on any device.", danger: true },
  { key: "monitoringDisabled", title: "Pause monitoring", detail: "Stop checking email and messages in the background.", danger: true },
  { key: "autoActivateLowRiskSkills", title: "Let Lou adopt read-only skills", detail: "New skills that only read information turn on without asking. Anything that acts always asks." },
];

export function Settings() {
  const settings = useLoad(() => api.settings());
  const info = useLoad(() => bridge().request<{ version: string; hotkey: string; connection?: { serverUrl: string | null } }>("app.info"));

  const update = async (key: keyof SettingsView, value: boolean) => {
    settings.setData(await api.updateSettings({ [key]: value }));
  };

  return (
    <>
      <h1 className="screen-title">Settings</h1>
      <p className="screen-sub">Controls that apply to every device.</p>

      {settings.error ? (
        <LoadError message={settings.error} onRetry={() => void settings.reload()} />
      ) : (
        <ul className="list">
          {CONTROLS.map((c) => (
            <li key={c.key} className="row">
              <div>
                <div className="row-title">{c.title}</div>
                <div className="row-sub" style={{ whiteSpace: "normal" }}>
                  {c.detail}
                </div>
              </div>
              <Toggle label={c.title} danger={c.danger} checked={!!settings.data?.[c.key]} onChange={(v) => void update(c.key, v)} />
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">This computer</h2>
      <ul className="list">
        <li className="row">
          <div>
            <div className="row-title">Shortcut</div>
            <div className="row-sub">Opens Lou from anywhere</div>
          </div>
          <kbd>{info.data?.hotkey ?? "Alt+Space"}</kbd>
        </li>
        <li className="row">
          <div>
            <div className="row-title">Server</div>
            <div className="row-sub">{info.data?.connection?.serverUrl ?? "—"}</div>
          </div>
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (confirm("Sign this computer out of Lou? You'll need a new pairing code to reconnect.")) await bridge().request("pairing.reset");
            }}
          >
            Sign out
          </button>
        </li>
        <li className="row">
          <div className="row-title">Version</div>
          <span className="hint">{info.data?.version ?? ""}</span>
        </li>
      </ul>
    </>
  );
}
