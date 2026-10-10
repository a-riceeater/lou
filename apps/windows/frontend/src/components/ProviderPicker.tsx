import type { AiProvider, ProviderStatus } from "@lou/protocol";
import { useState } from "react";
import { api, friendlyError } from "../api/client";
import { useLoad } from "./ui";

const DOT: Record<string, string> = { ready: "on", starting: "warn", crashed: "warn", stopped: "", not_signed_in: "warn" };

/** Aliases Claude Code resolves to the latest model of each family. */
const CLAUDE_MODELS = [
  { value: "", label: "Claude Code default" },
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * Model backend selection: OpenAI API, or the server's Codex CLI or Claude Code.
 * Switching takes effect for the next request; runs already waiting on an
 * approval finish on the provider that started them.
 */
export function ProviderPicker() {
  const providers = useLoad(() => api.providers(false));
  const settings = useLoad(() => api.settings());
  const [busy, setBusy] = useState<AiProvider | "check" | "model" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = async (id: AiProvider) => {
    if (providers.data?.active === id) return;
    setBusy(id);
    setError(null);
    try {
      settings.setData(await api.updateSettings({ aiProvider: id }));
      // Selecting a CLI checks it right away (starts Codex, verifies Claude Code's sign-in).
      providers.setData(await api.providers(id !== "openai_api"));
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

  const setClaudeModel = async (model: string) => {
    setBusy("model");
    setError(null);
    try {
      settings.setData(await api.updateSettings({ claudeModel: model || null }));
      providers.setData(await api.providers(false));
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const claudeModel = settings.data?.claudeModel ?? "";
  const models = CLAUDE_MODELS.some((m) => m.value === claudeModel) ? CLAUDE_MODELS : [...CLAUDE_MODELS, { value: claudeModel, label: claudeModel }];

  return (
    <>
      <div className="provider-list" role="radiogroup" aria-label="Assistant model">
        {providers.data?.items.map((p) => (
          <ProviderRow key={p.id} p={p} busy={busy === p.id} onSelect={() => void select(p.id)} />
        ))}
      </div>
      {providers.data?.active === "claude_cli" && settings.data && (
        <label className="field provider-model">
          <span>Claude model</span>
          <select className="select" value={claudeModel} disabled={busy !== null} onChange={(e) => void setClaudeModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="inline-form" style={{ marginTop: 6 }}>
        <button className="btn" style={{ marginLeft: -16 }} onClick={() => void check()} disabled={busy !== null}>
          {busy === "check" ? "Checking…" : "Check status"}
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
