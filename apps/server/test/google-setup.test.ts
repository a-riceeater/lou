import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { settings } from "../src/db/schema";
import { connectGmail, FakeGoogle, pairDevice, startTestServer, type TestServer } from "./helpers";

const CLIENT_ID = "1234-loutest.apps.googleusercontent.com";
const CLIENT_SECRET = "test-secret-abcdefghijkl";

let server: TestServer;
afterEach(async () => server?.close());

async function setup() {
  const google = new FakeGoogle();
  google.clientSecret = CLIENT_SECRET;
  server = await startTestServer({ google, googleEnv: false });
  const device = await pairDevice(server);
  return { google, device, auth: { authorization: `Bearer ${device.deviceToken}` } };
}

describe("Gmail setup from the app", () => {
  it("reports not set up, then verifies and stores the OAuth client without exposing the secret", async () => {
    const { google, device, auth } = await setup();

    expect((await server.app.inject({ method: "GET", url: "/api/google", headers: auth })).json()).toMatchObject({
      configSource: null,
      clientId: null,
      redirectUri: "http://localhost:8787/oauth/google/callback",
      scopes: expect.arrayContaining(["https://www.googleapis.com/auth/gmail.compose"]),
    });
    expect((await server.app.inject({ method: "GET", url: "/api/accounts", headers: auth })).json().available.google).toBe(false);
    const early = await server.app.inject({ method: "POST", url: "/api/accounts/google/connect", headers: auth });
    expect(early.json().error).toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("Set up Gmail") });

    const malformed = await server.app.inject({ method: "POST", url: "/api/google/app", headers: auth, payload: { clientId: "not-a-client-id", clientSecret: CLIENT_SECRET } });
    expect(malformed.json().error.message).toContain(".apps.googleusercontent.com");

    const rejected = await server.app.inject({ method: "POST", url: "/api/google/app", headers: auth, payload: { clientId: CLIENT_ID, clientSecret: "test-secret-wrongwrongwr" } });
    expect(rejected.json().error.message).toContain("rejected");
    expect(server.services.google.configured).toBe(false);

    const saved = await server.app.inject({ method: "POST", url: "/api/google/app", headers: auth, payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configSource: "server", clientId: CLIENT_ID });
    expect(saved.body).not.toContain(CLIENT_SECRET);
    const stored = JSON.stringify(server.services.db.select().from(settings).where(eq(settings.key, "google_app")).get());
    expect(stored).toContain(CLIENT_ID);
    expect(stored).not.toContain(CLIENT_SECRET);
    expect(google.tokenRequests.at(-1)?.get("redirect_uri")).toBe("http://localhost:8787/oauth/google/callback");

    // The saved client is used for sign-in and the account connects end to end.
    const start = await server.app.inject({ method: "POST", url: "/api/accounts/google/connect", headers: auth });
    expect(new URL(start.json().authUrl).searchParams.get("client_id")).toBe(CLIENT_ID);
    await connectGmail(server, device.deviceToken);
    expect(google.tokenRequests.at(-1)?.get("client_secret")).toBe(CLIENT_SECRET);
    expect((await server.app.inject({ method: "GET", url: "/api/accounts", headers: auth })).json()).toMatchObject({
      available: { google: true },
      items: [expect.objectContaining({ provider: "google", address: "me@example.com", status: "connected" })],
    });
  });

  it("asks connected accounts to reconnect when the OAuth client changes, and can be removed", async () => {
    const { google, device, auth } = await setup();
    await server.app.inject({ method: "POST", url: "/api/google/app", headers: auth, payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    await connectGmail(server, device.deviceToken);

    const otherId = CLIENT_ID.replace("1234", "5678");
    google.clientSecret = "test-secret-anotheranoth";
    await server.app.inject({ method: "POST", url: "/api/google/app", headers: auth, payload: { clientId: otherId, clientSecret: google.clientSecret } });
    const items = (await server.app.inject({ method: "GET", url: "/api/accounts", headers: auth })).json().items;
    expect(items).toEqual([expect.objectContaining({ status: "needs_reauth" })]);

    const removed = await server.app.inject({ method: "DELETE", url: "/api/google/app", headers: auth });
    expect(removed.json()).toMatchObject({ configSource: null, clientId: null });
    expect(server.services.google.configured).toBe(false);
  });

  it("leaves an environment-configured client alone", async () => {
    server = await startTestServer();
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    expect((await server.app.inject({ method: "GET", url: "/api/google", headers: auth })).json()).toMatchObject({ configSource: "env", clientId: "client-id" });
    const res = await server.app.inject({ method: "POST", url: "/api/google/app", headers: auth, payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    expect(res.json().error.code).toBe("CONFLICT");
    expect((await server.app.inject({ method: "DELETE", url: "/api/google/app", headers: auth })).json().error.code).toBe("CONFLICT");
  });
});
