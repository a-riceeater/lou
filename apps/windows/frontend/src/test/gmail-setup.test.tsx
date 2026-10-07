import type { GoogleSetupStatus } from "@lou/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setBridge } from "../bridge/bridge";
import { Accounts } from "../screens/Accounts";
import { TestBridge as BaseBridge } from "./testBridge";

const CLIENT_ID = "1234-loutest.apps.googleusercontent.com";
const REDIRECT = "https://lou.example.com/oauth/google/callback";

// Accounts also renders the Spotify section; keep it quiet.
class TestBridge extends BaseBridge {
  constructor() {
    super();
    this.route("GET /api/spotify", () => ({ state: "not_configured", configSource: null, clientId: null, redirectUri: "", scopes: [], account: null, lastError: null }));
  }
}

const setup = (overrides: Partial<GoogleSetupStatus> = {}): GoogleSetupStatus => ({
  configSource: null,
  clientId: null,
  redirectUri: REDIRECT,
  scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
  ...overrides,
});

describe("Gmail setup in Accounts", () => {
  it("walks through the Google Cloud steps, saves the client, then opens Google sign-in", async () => {
    let configured = false;
    const bridge = new TestBridge()
      .route("GET /api/accounts", () => ({ items: [], available: { google: configured, instagram: true } }))
      .route("GET /api/google", () => setup())
      .route("POST /api/google/app", (body) => {
        configured = true;
        return setup({ configSource: "server", clientId: body.clientId });
      })
      .route("POST /api/accounts/google/connect", () => ({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" }));
    setBridge(bridge);
    const user = userEvent.setup();
    render(<Accounts />);

    expect(await screen.findByText(/one-time Google Cloud setup/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Gmail" }));
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up Gmail" });
    expect(dialog).toHaveTextContent(REDIRECT);
    expect(dialog).toHaveTextContent("Web application");
    expect(dialog).toHaveTextContent("test user");
    expect(dialog).toHaveTextContent("gmail.compose");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(bridge.calls.find((c) => c.method === "clipboard.write")?.params).toEqual({ text: REDIRECT });
    await user.click(screen.getByRole("button", { name: "Open the Gmail API in Google Cloud" }));
    expect(bridge.calls.find((c) => c.method === "app.openExternal")?.params).toEqual({ url: "https://console.cloud.google.com/apis/library/gmail.googleapis.com" });

    await user.type(screen.getByLabelText("Client ID"), CLIENT_ID);
    await user.type(screen.getByLabelText("Client secret"), "test-secret-secretsecret");
    await user.click(screen.getByRole("button", { name: "Save and add Gmail" }));

    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "app.openExternal").at(-1)?.params).toEqual({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" }));
    expect(bridge.apiCalls("/api/google/app")[0].body).toEqual({ clientId: CLIENT_ID, clientSecret: "test-secret-secretsecret" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("fills both fields from Google's downloaded client JSON", async () => {
    setBridge(new TestBridge().route("GET /api/accounts", () => ({ items: [], available: { google: false, instagram: true } })).route("GET /api/google", () => setup()));
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(await screen.findByRole("button", { name: "Add Gmail" }));
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByLabelText("Client ID"));
    await user.paste(JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: "test-secret-fromjsonfrom", redirect_uris: [REDIRECT] } }));
    expect(screen.getByLabelText("Client ID")).toHaveValue(CLIENT_ID);
    expect(screen.getByLabelText("Client secret")).toHaveValue("test-secret-fromjsonfrom");
  });

  it("keeps the dialog open with the server's error when Google rejects the client", async () => {
    setBridge(
      new TestBridge()
        .route("GET /api/accounts", () => ({ items: [], available: { google: false, instagram: true } }))
        .route("GET /api/google", () => setup())
        .route("POST /api/google/app", () => ({ status: 400, body: { error: { code: "VALIDATION_FAILED", message: "Google rejected the Client ID or Client secret." } } })),
    );
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(await screen.findByRole("button", { name: "Add Gmail" }));
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await user.type(await screen.findByLabelText("Client ID"), CLIENT_ID);
    await user.type(screen.getByLabelText("Client secret"), "test-secret-wrongwrongwr");
    await user.click(screen.getByRole("button", { name: "Save and add Gmail" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens the existing Google sign-in from the method picker once Gmail is set up", async () => {
    const bridge = new TestBridge()
      .route("GET /api/accounts", () => ({ items: [], available: { google: true, instagram: true } }))
      .route("GET /api/google", () => setup({ configSource: "env", clientId: CLIENT_ID }))
      .route("POST /api/accounts/google/connect", () => ({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=t" }));
    setBridge(bridge);
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(await screen.findByRole("button", { name: "Add Gmail" }));
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "app.openExternal")?.params).toEqual({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=t" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Gmail Apps Script setup", () => {
  it("creates and copies one generated script, then automatically reports connection", async () => {
    let connected = false;
    const script = '// private integration credential\nfunction setupLou() {}';
    const bridge = new TestBridge()
      .route("GET /api/accounts", () => ({ items: connected ? [{ id: "acc_script", provider: "google", connectionMethod: "appscript", address: "student@example.edu", displayName: "School", status: "connected", capabilities: [], lastCheckedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString(), lastError: null, syncState: "connected" }] : [], available: { google: false, instagram: true } }))
      .route("GET /api/google", () => setup())
      .route("POST /api/accounts/google/appscript", () => ({ accountId: "acc_script", script }));
    setBridge(bridge);
    const user = userEvent.setup();
    render(<Accounts />);
    await user.click(await screen.findByRole("button", { name: "Add Gmail" }));
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect using Google Apps Script" }));
    const copy = await screen.findByRole("button", { name: "Copy Script" });
    expect(screen.getByLabelText("Generated Apps Script")).toHaveTextContent("setupLou");
    await user.click(copy);
    expect(bridge.calls.find(c => c.method === "clipboard.write")?.params).toEqual({ text: script });
    await user.click(screen.getByRole("button", { name: "Open Google Apps Script" }));
    expect(bridge.calls.find(c => c.method === "app.openExternal")?.params).toEqual({ url: "https://script.google.com" });
    expect(bridge.apiCalls("/api/accounts/google/appscript")).toHaveLength(1);
    connected = true;
    expect(await screen.findByRole("button", { name: "Done" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText("Generated Apps Script")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Connected via Apps Script/).length).toBeGreaterThan(0);
    expect(bridge.apiCalls("/api/accounts/google/connect")).toHaveLength(0);
  });

  it("shows stale state and regenerates the selected connection without using OAuth", async () => {
    const bridge = new TestBridge()
      .route("GET /api/accounts", () => ({ items: [{ id: "acc_stale", provider: "google", connectionMethod: "appscript", address: "student@example.edu", displayName: "School", status: "error", capabilities: [], lastCheckedAt: null, lastSyncedAt: null, lastError: null, syncState: "stale" }], available: { google: true, instagram: true } }))
      .route("GET /api/google", () => setup({ configSource: "env", clientId: CLIENT_ID }))
      .route("POST /api/accounts/acc_stale/appscript/reset", () => ({ accountId: "acc_stale", script: "// regenerated secret" }));
    setBridge(bridge);
    const user = userEvent.setup();
    render(<Accounts />);
    expect(await screen.findByText(/Script not running \/ stale connection/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Regenerate script" }));
    expect(screen.getByText(/immediately revokes the old script/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Regenerate script / reset connection" }));
    await screen.findByRole("button", { name: "Copy Script" });
    expect(bridge.apiCalls("/api/accounts/acc_stale/appscript/reset")).toHaveLength(1);
    expect(bridge.apiCalls("/api/accounts/google/connect")).toHaveLength(0);
  });
});
