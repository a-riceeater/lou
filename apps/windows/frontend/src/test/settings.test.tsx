import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setBridge } from "../bridge/bridge";
import { ProviderPicker } from "../components/ProviderPicker";
import { TestBridge } from "./testBridge";

type Provider = "openai_api" | "codex_cli" | "claude_cli";

const status = (active: Provider, codexState = "ready", claude: { state?: string; model?: string | null } = {}) => ({
  active,
  items: [
    { id: "openai_api", label: "OpenAI API", active: active === "openai_api", state: "ready", summary: "Ready", hint: null, details: { Model: "gpt-6-luna" } },
    {
      id: "codex_cli",
      label: "Codex CLI",
      active: active === "codex_cli",
      state: codexState,
      summary: codexState === "ready" ? "Connected" : "Not signed in",
      hint: codexState === "ready" ? null : "Run: codex login",
      details: { CLI: "installed (0.151.0)", Authentication: codexState === "ready" ? "ChatGPT (plus)" : "not signed in" },
    },
    {
      id: "claude_cli",
      label: "Claude Code",
      active: active === "claude_cli",
      state: claude.state ?? "ready",
      summary: (claude.state ?? "ready") === "ready" ? "Connected" : "Not signed in",
      hint: (claude.state ?? "ready") === "ready" ? null : "Run: claude auth login",
      details: { CLI: "installed (2.1.296)", Authentication: "Claude subscription (max)", Model: claude.model ?? "Claude Code default" },
    },
  ],
});

const settingsView = (aiProvider: Provider, claudeModel: string | null = null) => ({
  writeToolsDisabled: false,
  deviceControlDisabled: false,
  monitoringDisabled: false,
  agentPaused: false,
  autoActivateLowRiskSkills: false,
  aiProvider,
  claudeModel,
});

describe("assistant model settings", () => {
  it("shows every provider and switches to Codex", async () => {
    let active: Provider = "openai_api";
    const bridge = new TestBridge()
      .route("GET /api/providers", () => status(active))
      .route("GET /api/settings", () => settingsView(active))
      .route("PATCH /api/settings", (body) => {
        active = body.aiProvider;
        return settingsView(active);
      });
    setBridge(bridge);
    const user = userEvent.setup();
    render(<ProviderPicker />);
    const codex = await screen.findByRole("radio", { name: /Codex CLI/ });
    expect(screen.getByRole("radio", { name: /OpenAI API/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "false");
    await user.click(codex);
    expect(bridge.apiCalls("/api/settings").find((c) => c.method === "PATCH").body).toEqual({ aiProvider: "codex_cli" });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Codex CLI/ })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    expect(screen.getByText("ChatGPT (plus)")).toBeInTheDocument();
    // Selecting Codex probes its status (starts the App Server on the server).
    expect(bridge.apiCalls("/api/providers").some((c) => String(c.path).includes("probe=1"))).toBe(true);
    // The Claude model choice only shows while Claude Code is selected.
    expect(screen.queryByLabelText("Claude model")).not.toBeInTheDocument();
  });

  it("switches to Claude Code and lets the user pick its model", async () => {
    let active: Provider = "openai_api";
    let model: string | null = null;
    const bridge = new TestBridge()
      .route("GET /api/providers", () => status(active, "ready", { model }))
      .route("GET /api/settings", () => settingsView(active, model))
      .route("PATCH /api/settings", (body) => {
        if (body.aiProvider) active = body.aiProvider;
        if ("claudeModel" in body) model = body.claudeModel;
        return settingsView(active, model);
      });
    setBridge(bridge);
    const user = userEvent.setup();
    render(<ProviderPicker />);
    await user.click(await screen.findByRole("radio", { name: /Claude Code/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("Claude subscription (max)")).toBeInTheDocument();
    expect(bridge.apiCalls("/api/providers").some((c) => String(c.path).includes("probe=1"))).toBe(true);

    const select = await screen.findByLabelText("Claude model");
    expect(select).toHaveValue("");
    await user.selectOptions(select, "sonnet");
    const patches = bridge.apiCalls("/api/settings").filter((c) => c.method === "PATCH");
    expect(patches.at(-1).body).toEqual({ claudeModel: "sonnet" });
    await waitFor(() => expect(screen.getByLabelText("Claude model")).toHaveValue("sonnet"));
    expect(screen.getByText("sonnet")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Claude model"), "");
    expect(bridge.apiCalls("/api/settings").filter((c) => c.method === "PATCH").at(-1).body).toEqual({ claudeModel: null });
  });

  it("keeps a model configured on the server that isn't one of the presets", async () => {
    setBridge(
      new TestBridge()
        .route("GET /api/providers", () => status("claude_cli", "ready", { model: "claude-opus-5-5" }))
        .route("GET /api/settings", () => settingsView("claude_cli", "claude-opus-5-5")),
    );
    render(<ProviderPicker />);
    expect(await screen.findByLabelText("Claude model")).toHaveValue("claude-opus-5-5");
  });

  it("tells the user how to sign in to Codex and Claude Code", async () => {
    setBridge(
      new TestBridge().route("GET /api/providers", () => status("codex_cli", "not_signed_in", { state: "not_signed_in" })).route("GET /api/settings", () => settingsView("codex_cli")),
    );
    render(<ProviderPicker />);
    expect(await screen.findByText("Run: codex login")).toBeInTheDocument();
    expect(screen.getByText("Run: claude auth login")).toBeInTheDocument();
    expect(screen.getAllByText("Not signed in")).toHaveLength(2);
  });
});
