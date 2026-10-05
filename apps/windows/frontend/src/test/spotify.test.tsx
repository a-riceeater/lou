import type { SpotifyPlayerView, SpotifyStatus } from "@lou/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setBridge } from "../bridge/bridge";
import { NowPlaying } from "../components/NowPlaying";
import { Accounts } from "../screens/Accounts";
import { TestBridge } from "./testBridge";

const status = (overrides: Partial<SpotifyStatus> = {}): SpotifyStatus => ({
  state: "connected",
  configSource: "server",
  clientId: "0123456789abcdef0123456789abcdef",
  redirectUri: "https://lou.example.com/oauth/spotify/callback",
  scopes: ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"],
  account: { id: "acc_spotify", displayName: "Alex", spotifyUserId: "alex" },
  lastError: null,
  ...overrides,
});

const player = (overrides: Partial<SpotifyPlayerView> = {}): SpotifyPlayerView => ({
  active: true,
  isPlaying: true,
  item: { type: "track", name: "Pink Pony Club", artists: ["Chappell Roan"], album: "The Rise and Fall of a Midwest Princess", imageUrl: "https://i.scdn.co/image/x", url: "https://open.spotify.com/track/x", durationMs: 258_000 },
  progressMs: 61_000,
  fetchedAt: new Date().toISOString(),
  device: { id: "d1", name: "DESKTOP-ALEX", type: "Computer", isActive: true, isRestricted: false, volumePercent: 50, supportsVolume: true },
  shuffle: false,
  repeat: "off",
  ...overrides,
});

describe("Spotify in Accounts", () => {
  it("walks through setup: redirect URI, credentials, then sign-in in the browser", async () => {
    let current = status({ state: "not_configured", configSource: null, clientId: null, account: null });
    const bridge = new TestBridge()
      .route("GET /api/accounts", () => ({ items: [], available: { google: true, instagram: true, spotify: false } }))
      .route("GET /api/spotify", () => current)
      .route("POST /api/spotify/app", (body) => {
        current = status({ state: "disconnected", clientId: body.clientId, account: null });
        return current;
      })
      .route("POST /api/accounts/spotify/connect", () => ({ authUrl: "https://accounts.spotify.com/authorize?state=s" }));
    setBridge(bridge);
    const user = userEvent.setup();
    render(<Accounts />);

    expect(await screen.findByText("Not set up on your server yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up" }));
    const dialog = screen.getByRole("dialog", { name: "Set up Spotify" });
    expect(dialog).toHaveTextContent("https://lou.example.com/oauth/spotify/callback");
    expect(dialog).toHaveTextContent("User Management");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(bridge.calls.find((c) => c.method === "clipboard.write")?.params).toEqual({ text: "https://lou.example.com/oauth/spotify/callback" });
    await user.click(screen.getByRole("button", { name: "Open Spotify Developer Dashboard" }));
    expect(bridge.calls.find((c) => c.method === "app.openExternal")?.params).toEqual({ url: "https://developer.spotify.com/dashboard" });

    await user.type(screen.getByLabelText("Client ID"), "0123456789abcdef0123456789abcdef");
    await user.type(screen.getByLabelText("Client secret"), "fedcba9876543210fedcba9876543210");
    await user.click(screen.getByRole("button", { name: "Save and connect" }));

    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "app.openExternal").at(-1)?.params).toEqual({ url: "https://accounts.spotify.com/authorize?state=s" }));
    expect(bridge.apiCalls("/api/spotify/app")[0].body).toEqual({ clientId: "0123456789abcdef0123456789abcdef", clientSecret: "fedcba9876543210fedcba9876543210" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
  });

  it("shows the server's error when credentials are rejected", async () => {
    setBridge(
      new TestBridge()
        .route("GET /api/spotify", () => status({ state: "not_configured", configSource: null, clientId: null, account: null }))
        .route("POST /api/spotify/app", () => ({ status: 503, body: { error: { code: "NOT_CONFIGURED", message: "Spotify rejected the app's Client ID or Client secret." } } })),
    );
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(await screen.findByRole("button", { name: "Set up" }));
    await user.type(screen.getByLabelText("Client ID"), "x".repeat(32));
    await user.type(screen.getByLabelText("Client secret"), "y".repeat(32));
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows the account and active device, and disconnects", async () => {
    let current = status();
    const bridge = new TestBridge()
      .route("GET /api/spotify", () => current)
      .route("GET /api/spotify/player", () => player())
      .route("DELETE /api/accounts/acc_spotify", () => {
        current = status({ state: "disconnected", account: null });
        return { ok: true };
      });
    setBridge(bridge);
    const user = userEvent.setup();
    render(<Accounts />);
    expect(await screen.findByText(/Connected as Alex · Playing on DESKTOP-ALEX/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect Spotify" })).toBeInTheDocument();
  });

  it("offers Reconnect when authorization was revoked", async () => {
    setBridge(new TestBridge().route("GET /api/spotify", () => status({ state: "needs_reauth", lastError: "Spotify authorization was revoked or expired." })));
    render(<Accounts />);
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByText("Spotify authorization was revoked or expired.")).toBeInTheDocument();
  });
});

describe("Now Playing", () => {
  it("shows the current track and controls playback remotely", async () => {
    let view = player();
    const bridge = new TestBridge()
      .route("GET /api/spotify", () => status())
      .route("GET /api/spotify/player", () => view)
      .route("POST /api/spotify/player", (body) => {
        view = player({ isPlaying: body.action !== "pause" });
        return { ok: true };
      });
    setBridge(bridge);
    const user = userEvent.setup();
    render(<NowPlaying />);
    expect(await screen.findByText("Pink Pony Club")).toBeInTheDocument();
    expect(screen.getByText("Chappell Roan")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Playback position" })).toHaveAttribute("aria-valuenow", "61");

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(bridge.apiCalls("/api/spotify/player").find((c) => c.method === "POST")?.body).toEqual({ action: "pause" });
    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next track" }));
    expect(bridge.apiCalls("/api/spotify/player").filter((c) => c.method === "POST").at(-1)?.body).toEqual({ action: "next" });

    await user.click(screen.getByRole("button", { name: "Open in Spotify" }));
    expect(bridge.calls.find((c) => c.method === "app.openExternal")?.params).toEqual({ url: "https://open.spotify.com/track/x" });
  });

  it("stays hidden when Spotify isn't connected or nothing is active", async () => {
    const bridge = new TestBridge().route("GET /api/spotify", () => status({ state: "disconnected", account: null }));
    setBridge(bridge);
    const { container } = render(<NowPlaying />);
    await waitFor(() => expect(bridge.apiCalls("/api/spotify")).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
    expect(bridge.apiCalls("/api/spotify/player")).toHaveLength(0);

    setBridge(new TestBridge().route("GET /api/spotify", () => status()).route("GET /api/spotify/player", () => player({ active: false, item: null, device: null })));
    const idle = render(<NowPlaying />);
    await new Promise((r) => setTimeout(r, 30));
    expect(idle.container).toBeEmptyDOMElement();
  });

  it("refreshes after Lou finishes a request", async () => {
    let view = player({ item: { ...player().item!, name: "Before" } });
    const bridge = new TestBridge().route("GET /api/spotify", () => status()).route("GET /api/spotify/player", () => view);
    setBridge(bridge);
    render(<NowPlaying />);
    expect(await screen.findByText("Before")).toBeInTheDocument();
    view = player({ item: { ...player().item!, name: "After" } });
    bridge.server("agent.completed", { runId: "r1", status: "completed", message: "Skipped.", error: null });
    expect(await screen.findByText("After", {}, { timeout: 2000 })).toBeInTheDocument();
  });
});
