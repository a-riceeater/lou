import type { ClaudeCliManager, ClaudeHealth, CodexAppServerManager, CodexHealth, ModelProvider, ModelRequest, ModelResponse, ProviderId } from "@lou/agent";
import type { ProviderStatus } from "@lou/protocol";
import { LouError } from "@lou/shared";
import type { SettingsStore } from "../core/settings";
import type { Logger } from "../logger";

/** Order in which another provider is offered after a failure. */
const FALLBACK_ORDER: ProviderId[] = ["openai_api", "codex_cli", "claude_cli"];

/**
 * Model provider selection. The provider is a setting (AI_PROVIDER default,
 * switchable at runtime from Settings), never chosen implicitly: failures are
 * surfaced with an explicit fallback offer instead of silently switching.
 */
export class ModelProviders {
  constructor(
    private readonly settings: SettingsStore,
    private readonly api: { model: ModelProvider | undefined; modelName: string },
    private readonly codex: { manager: CodexAppServerManager; model: ModelProvider; modelName: string | undefined },
    private readonly claude: { manager: ClaudeCliManager; model: ModelProvider; modelName: () => string | undefined },
    private readonly logger: Logger,
  ) {
    // Start Codex when it becomes the selected provider and stop it when it isn't; check Claude Code when it's selected.
    settings.onChange((next, previous) => {
      if (next.aiProvider === previous.aiProvider) return;
      if (next.aiProvider !== "codex_cli") void codex.manager.stop();
      this.warmUp();
    });
  }

  active(): ProviderId {
    return this.settings.get().aiProvider;
  }

  /** Starts the Codex App Server, or checks Claude Code, in the background when it's the selected provider. */
  warmUp(): void {
    const active = this.active();
    if (active === "codex_cli") void this.codex.manager.ensureStarted().catch((err) => this.logger.warn({ err: (err as Error).message }, "codex provider unavailable"));
    if (active === "claude_cli") void this.claude.manager.ensureReady().catch((err) => this.logger.warn({ err: (err as Error).message }, "claude provider unavailable"));
  }

  /** ModelProvider for single-shot tasks (classification, drafting, evaluation) following the selected provider. */
  readonly selected: ModelProvider = {
    id: "selected",
    get defaultModel(): string {
      return "selected";
    },
    complete: (request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> => {
      const active = this.active();
      const provider = active === "codex_cli" ? this.codex.model : active === "claude_cli" ? this.claude.model : this.api.model;
      if (!provider) throw new LouError("NOT_CONFIGURED", "The OpenAI API isn't configured on the server (OPENAI_API_KEY).");
      return provider.complete(request, signal);
    },
  };

  /** A different provider that is usable right now, offered (never applied) after a failure. */
  fallbackFor(provider: ProviderId): ProviderId | undefined {
    return FALLBACK_ORDER.find((id) => id !== provider && this.usable(id));
  }

  private usable(id: ProviderId): boolean {
    if (id === "openai_api") return !!this.api.model;
    if (id === "codex_cli") return this.codex.manager.state === "ready";
    return this.claude.manager.state === "ready";
  }

  modelLabel(): string {
    const active = this.active();
    if (active === "codex_cli") return `Codex CLI${this.codex.modelName ? ` (${this.codex.modelName})` : ""}`;
    if (active === "claude_cli") {
      const model = this.claude.modelName();
      return `Claude Code${model ? ` (${model})` : ""}`;
    }
    return this.api.modelName;
  }

  async statuses(probe: boolean): Promise<ProviderStatus[]> {
    const active = this.active();
    const codexHealth = probe || active === "codex_cli" ? await this.codex.manager.health() : this.codex.manager.snapshot();
    // A probe re-checks Claude Code now; otherwise a recent check is reused.
    const claudeHealth = probe ? await this.claude.manager.health() : active === "claude_cli" ? await this.claude.manager.health(false) : this.claude.manager.snapshot();
    return [
      {
        id: "openai_api",
        label: "OpenAI API",
        active: active === "openai_api",
        state: this.api.model ? "ready" : "not_configured",
        summary: this.api.model ? "Ready" : "Not set up",
        hint: this.api.model ? null : "Set OPENAI_API_KEY on the server.",
        details: { Model: this.api.modelName, Authentication: this.api.model ? "API key" : "none" },
      },
      codexStatus(codexHealth, active === "codex_cli", this.codex.modelName),
      claudeStatus(claudeHealth, active === "claude_cli", this.claude.modelName()),
    ];
  }
}

function codexStatus(h: CodexHealth, active: boolean, model: string | undefined): ProviderStatus {
  const copy: Record<string, { summary: string; hint: string | null }> = {
    ready: { summary: "Connected", hint: null },
    starting: { summary: "Starting", hint: null },
    stopped: { summary: "Not running", hint: active ? null : "Select it to start Codex." },
    not_installed: { summary: "Unavailable", hint: `${h.lastError ?? "Codex executable not found"}. Install it with: npm install -g @openai/codex` },
    not_signed_in: { summary: "Not signed in", hint: "Run: codex login" },
    crashed: { summary: "Restarting", hint: h.lastError },
    error: { summary: "Unavailable", hint: h.lastError },
  };
  const c = copy[h.state] ?? { summary: h.state, hint: h.lastError };
  const details: Record<string, string> = {
    CLI: h.installed ? `installed${h.cliVersion ? ` (${h.cliVersion})` : ""}` : h.state === "stopped" ? "not checked" : "not found",
    Status: c.summary.toLowerCase(),
  };
  if (h.auth) details.Authentication = h.auth.mode === "chatgpt" ? `ChatGPT${h.auth.plan ? ` (${h.auth.plan})` : ""}` : h.auth.mode === "apiKey" ? "API key" : "Bedrock";
  else if (h.state === "not_signed_in") details.Authentication = "not signed in";
  if (model) details.Model = model;
  if (h.state === "ready") details.Sandbox = "locked down: Lou tools only";
  return { id: "codex_cli", label: "Codex CLI", active, state: h.state, summary: c.summary, hint: c.hint, details };
}

const CLOUD_LABELS: Record<string, string> = { bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", foundry: "Microsoft Foundry" };

function claudeStatus(h: ClaudeHealth, active: boolean, model: string | undefined): ProviderStatus {
  const copy: Record<string, { summary: string; hint: string | null }> = {
    ready: { summary: "Connected", hint: null },
    starting: { summary: "Checking", hint: null },
    stopped: { summary: "Not checked", hint: active ? null : "Select it to check Claude Code." },
    not_installed: { summary: "Unavailable", hint: `${h.lastError ?? "Claude Code executable not found"}. Install it with: npm install -g @anthropic-ai/claude-code` },
    not_signed_in: { summary: "Not signed in", hint: "Run: claude auth login" },
    error: { summary: "Unavailable", hint: h.lastError },
  };
  const c = copy[h.state] ?? { summary: h.state, hint: h.lastError };
  const details: Record<string, string> = {
    CLI: h.installed ? `installed${h.cliVersion ? ` (${h.cliVersion})` : ""}` : h.state === "stopped" ? "not checked" : "not found",
    Status: c.summary.toLowerCase(),
  };
  if (h.auth) {
    const { method, plan, provider } = h.auth;
    details.Authentication =
      method === "subscription" ? `Claude subscription${plan ? ` (${plan})` : ""}` : method === "apiKey" ? "API key" : method === "cloud" ? (CLOUD_LABELS[provider ?? ""] ?? provider ?? "cloud provider") : "signed in";
  } else if (h.state === "not_signed_in") details.Authentication = "not signed in";
  details.Model = model ?? "Claude Code default";
  if (h.state === "ready") details.Sandbox = "locked down: Lou tools only";
  return { id: "claude_cli", label: "Claude Code", active, state: h.state, summary: c.summary, hint: c.hint, details };
}
