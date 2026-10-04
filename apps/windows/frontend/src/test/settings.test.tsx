import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setBridge } from "../bridge/bridge";
import { ProviderPicker } from "../components/ProviderPicker";
import { TestBridge } from "./testBridge";

const status = (active: "openai_api" | "codex_cli", codexState = "ready") => ({
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
  ],
});

describe("assistant model settings", () => {
  it("shows both providers and switches to Codex", async () => {
    let active: "openai_api" | "codex_cli" = "openai_api";
    const bridge = new TestBridge()
      .route("GET /api/providers", () => status(active))
      .route("PATCH /api/settings", (body) => {
        active = body.aiProvider;
        return { aiProvider: active };
      });
    setBridge(bridge);
    const user = userEvent.setup();
    render(<ProviderPicker />);
    const codex = await screen.findByRole("radio", { name: /Codex CLI/ });
    expect(screen.getByRole("radio", { name: /OpenAI API/ })).toHaveAttribute("aria-checked", "true");
    await user.click(codex);
    expect(bridge.apiCalls("/api/settings")[0].body).toEqual({ aiProvider: "codex_cli" });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Codex CLI/ })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT (plus)")).toBeInTheDocument();
    // Selecting Codex probes its status (starts the App Server on the server).
    expect(bridge.apiCalls("/api/providers").some((c) => String(c.path).includes("probe=1"))).toBe(true);
  });

  it("tells the user how to sign in to Codex", async () => {
    setBridge(new TestBridge().route("GET /api/providers", () => status("codex_cli", "not_signed_in")));
    render(<ProviderPicker />);
    expect(await screen.findByText("Run: codex login")).toBeInTheDocument();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
  });
});
