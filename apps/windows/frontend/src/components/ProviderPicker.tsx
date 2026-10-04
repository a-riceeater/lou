import type { AiProvider, ProviderStatus } from "@lou/protocol";
import { useState } from "react";
import { api, friendlyError } from "../api/client";
import { useLoad } from "./ui";

const DOT: Record<string, string> = { ready: "on", starting: "warn", crashed: "warn", stopped: "", not_signed_in: "warn" };

/**
 * Model backend selection: OpenAI API or the server's Codex CLI. Switching takes
 * effect for the next request; runs already waiting on an approval finish on the
 * provider that started them.
 */
export function ProviderPicker() {
  const providers = useLoad(() => api.providers(false));
  const [busy, setBusy] = useState<AiProvider | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = async (id: AiProvider) => {
    if (providers.data?.active === id) return;
    setBusy(id);
    setError(null);
    try {
      await api.updateSettings({ aiProvider: id });
      providers.setData(await api.providers(id === "codex_cli"));
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      providers.setData(await api.providers(true));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="provider-list" role="radiogroup" aria-label="Assistant model">
        {providers.data?.items.map((p) => (
          <ProviderRow key={p.id} p={p} busy={busy === p.id} onSelect={() => void select(p.id)} />
        ))}
      </div>
      <div className="inline-form" style={{ marginTop: 6 }}>
        <button className="btn" style={{ marginLeft: -16 }} onClick={() => void check()} disabled={busy !== null}>
          {busy === "check" ? "Checking…" : "Check Codex status"}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {providers.error && <p className="error-text">{providers.error}</p>}
    </>
  );
}

function ProviderRow({ p, busy, onSelect }: { p: ProviderStatus; busy: boolean; onSelect(): void }) {
  return (
    <button type="button" role="radio" aria-checked={p.active} className={`provider${p.active ? " selected" : ""}`} onClick={onSelect} disabled={busy}>
      <span className="provider-radio" aria-hidden />
      <span className="provider-main">
        <span className="row-title">{p.label}</span>
        <span className="provider-status">
          <span className={`dot ${DOT[p.state] ?? "bad"}`} />
          {busy ? "Starting…" : p.summary}
        </span>
        {p.hint && <span className="provider-hint">{p.hint}</span>}
        {Object.keys(p.details).length > 0 && (
          <span className="provider-details">
            {Object.entries(p.details).map(([k, v]) => (
              <span key={k}>
                <span className="provider-key">{k}</span> {v}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}
