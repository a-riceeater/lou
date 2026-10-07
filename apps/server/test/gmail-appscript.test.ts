import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { gmailScriptCommands, gmailScriptConnections, gmailScriptMessages, oauthConnections, users } from "../src/db/schema";
import { gmailProviderFactory } from "../src/integrations/google/tools";
import { connectGmail, pairDevice, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
afterEach(async () => server?.close());
const message = { id: "m1", threadId: "t1", from: "friend@example.com", to: "school@example.edu", cc: "", bcc: "", replyTo: "", subject: "Hello", date: new Date().toISOString(), messageIdHeader: "<m1@example.com>", references: "", snippet: "Hi", labelIds: ["INBOX"], unread: false, bulk: false, body: "Hi", attachments: [], attachmentMetadata: [] };
async function setup() {
  server = await startTestServer({ env: { LOU_PUBLIC_URL: "https://lou.example.com" } });
  const device = await pairDevice(server);
  const auth = { authorization: `Bearer ${device.deviceToken}` };
  const create = async () => {
    const response = await server.app.inject({ method: "POST", url: "/api/accounts/google/appscript", headers: auth });
    expect(response.statusCode).toBe(200);
    const installation = response.json() as { accountId: string; script: string };
    const secret = JSON.parse(installation.script.match(/const INTEGRATION_SECRET = (.*);/)![1]!);
    return { ...installation, secret: secret as string };
  };
  const scriptRequest = (id: string, secret: string, path: string, payload: Record<string, unknown> = {}) => server.app.inject({ method: "POST", url: `/api/integrations/gmail-appscript/${path}`, headers: { authorization: `Bearer ${secret}` }, payload: { integrationId: id, protocolVersion: 1, ...payload } });
  return { device, auth, create, scriptRequest };
}

/** Execute the actual generated Code.gs against built-in service doubles. */
function scriptRuntime(script: string, request: (path: string, body: any) => unknown) {
  const properties = new Map<string, string>();
  let sends = 0;
  let draftId = 0;
  let triggers: any[] = [];
  let locked = false;
  const context = createContext({
    console: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => properties.get(k) ?? null, setProperty: (k: string, v: string) => properties.set(k, v), deleteProperty: (k: string) => properties.delete(k), getProperties: () => Object.fromEntries(properties) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !locked && (locked = true), waitLock: () => { locked = true; }, releaseLock: () => { locked = false; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "school@example.edu" }) },
    Utilities: { sleep() {}, newBlob: (s: string) => ({ getBytes: () => [...Buffer.from(s)] }), base64Decode: (s: string) => [...Buffer.from(s, "base64")], base64Encode: (bytes: number[]) => Buffer.from(bytes).toString("base64"), DigestAlgorithm: { SHA_256: "sha256" }, computeDigest: (_: string, s: string) => [...createHash("sha256").update(s).digest()] },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: (t: any) => { triggers = triggers.filter(v => v !== t); }, newTrigger: (handler: string) => ({ timeBased: () => ({ everyMinutes: (minutes: number) => ({ create: () => { expect(minutes).toBe(1); triggers.push({ getHandlerFunction: () => handler }); } }) }) }) },
    GmailApp: { getInboxUnreadCount: () => 0, search: () => [], createDraft: () => { draftId++; return { send: () => { sends++; return { getId: () => `sent${sends}`, getThread: () => ({ getId: () => "sent-thread" }) }; } }; } },
    UrlFetchApp: { fetch: (url: string, options: any) => {
      expect(options.followRedirects).toBe(false);
      const path = url.split("/gmail-appscript/")[1]!;
      const body = JSON.parse(options.payload);
      const data = request(path, body);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(data) };
    } },
  });
  runInContext(script, context);
  return { run: (code: string) => runInContext(code, context), properties, context, get sends() { return sends; }, get drafts() { return draftId; }, get triggers() { return triggers; } };
}

describe("Gmail Apps Script scoped API", () => {
  it("creates integration-specific scripts with hash-only credentials and no Google credentials", async () => {
    const { auth, create } = await setup();
    const a = await create(), b = await create();
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.length).toBeGreaterThanOrEqual(43);
    expect(a.script).toContain(`const INTEGRATION_ID = "${a.accountId}"`);
    expect(a.script).toContain('const LOU_SERVER = "https://lou.example.com"');
    expect(a.script).toContain("const LOU_PROTOCOL_VERSION = 1");
    expect(a.script).not.toMatch(/getOAuthToken|refresh_token|client-secret|doGet|doPost/);
    const stored = server.services.db.select().from(gmailScriptConnections).where(eq(gmailScriptConnections.accountId, a.accountId)).get()!;
    expect(stored.secretHash).toBe(createHash("sha256").update(a.secret).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(a.secret);
    expect(server.services.db.select().from(oauthConnections).all()).toHaveLength(0);
    const response = await server.app.inject({ method: "GET", url: "/api/accounts", headers: auth });
    expect(response.body).not.toContain(a.secret);
    expect(response.body).not.toContain(stored.secretHash);
    expect(response.body).not.toContain("script:");
    expect(response.json().items[0]).toMatchObject({ provider: "google", connectionMethod: "appscript", status: "pending" });
    runInContext(a.script, createContext({})); // Generated file is valid JavaScript.
  });

  it("rejects guessed IDs, wrong credentials, wrong versions, oversized and malformed payloads", async () => {
    const { create, scriptRequest } = await setup();
    const a = await create();
    expect((await scriptRequest(a.accountId, "invalid", "commands")).statusCode).toBe(401);
    expect((await scriptRequest("acc_guessed", a.secret, "commands")).statusCode).toBe(401);
    expect((await scriptRequest(a.accountId, a.secret, "commands", { protocolVersion: 2 })).statusCode).toBe(400);
    expect((await scriptRequest(a.accountId, a.secret, "sync", { messages: [{ id: "incomplete" }], cursor: "" })).statusCode).toBe(400);
    expect((await scriptRequest(a.accountId, a.secret, "heartbeat", { state: "connected", padding: "x".repeat(900_001) })).statusCode).toBe(413);
    expect((await server.app.inject({ method: "GET", url: "/api/accounts", headers: { authorization: `Bearer ${a.secret}` } })).statusCode).toBe(401);
  });

  it("integration A cannot read, claim, or report integration B commands", async () => {
    const { create, scriptRequest } = await setup();
    const a = await create(), b = await create();
    const command = server.services.gmailScript.enqueue(b.accountId, { operation: "PROFILE" });
    expect((await scriptRequest(b.accountId, a.secret, "commands")).statusCode).toBe(401);
    expect((await scriptRequest(a.accountId, a.secret, "commands")).json().commands).toEqual([]);
    expect((await scriptRequest(a.accountId, a.secret, `commands/${command}/claim`)).json()).toEqual({ execute: false });
    expect((await scriptRequest(a.accountId, a.secret, `commands/${command}/result`, { result: {} })).statusCode).toBe(404);
    expect((await scriptRequest(b.accountId, b.secret, "commands")).json().commands[0].id).toBe(command);
  });

  it("deduplicates synced messages/events and updates read state, heartbeat and stale status", async () => {
    const { auth, create, scriptRequest } = await setup();
    const a = await create();
    await scriptRequest(a.accountId, a.secret, "register", { address: "school@example.edu" });
    for (let i = 0; i < 2; i++) expect((await scriptRequest(a.accountId, a.secret, "sync", { messages: [message], cursor: "window1" })).statusCode).toBe(200);
    expect(server.services.db.select().from(gmailScriptMessages).all()).toHaveLength(1);
    expect(server.services.events.recent(server.services.owner.id)).toHaveLength(1);
    await scriptRequest(a.accountId, a.secret, "sync", { messages: [{ ...message, unread: true }], cursor: "window2" });
    expect(server.services.db.select().from(gmailScriptMessages).all()[0]!.data.unread).toBe(true);
    const list = () => server.services.integrations.list(server.services.owner.id)[0]!;
    expect(list()).toMatchObject({ address: "school@example.edu", connectionMethod: "appscript", status: "connected", syncState: "connected", lastSyncedAt: expect.any(String) });
    server.services.integrations.updateMetadata(a.accountId, { lastHeartbeat: new Date(Date.now() - 6 * 60_000).toISOString() });
    expect(list()).toMatchObject({ status: "error", syncState: "stale" });
    await scriptRequest(a.accountId, a.secret, "heartbeat", { state: "syncing" });
    expect(list()).toMatchObject({ status: "connected", syncState: "syncing" });
    await scriptRequest(a.accountId, a.secret, "heartbeat", { state: "authorization_required", error: "Gmail authorization denied" });
    expect(list()).toMatchObject({ status: "needs_reauth", lastError: "Gmail authorization denied" });
    expect((await server.app.inject({ method: "GET", url: "/api/accounts", headers: auth })).body).not.toContain(a.secret);
  });

  it("claims SEND once, persists approval idempotency, and ignores duplicate results", async () => {
    const { create, scriptRequest } = await setup();
    const a = await create();
    const input = { operation: "SEND" as const, email: { to: ["friend@example.com"], subject: "Hi", body: "Hello" } };
    const id = server.services.gmailScript.enqueue(a.accountId, input, "approval1");
    expect(server.services.gmailScript.enqueue(a.accountId, input, "approval1")).toBe(id);
    expect(() => server.services.gmailScript.enqueue(a.accountId, { ...input, email: { ...input.email, body: "changed" } }, "approval1")).toThrow("approved command changed");
    expect((await scriptRequest(a.accountId, a.secret, `commands/${id}/result`, { result: { id: "sent", threadId: "t" } })).statusCode).toBe(409);
    const claims = await Promise.all([1, 2].map(() => scriptRequest(a.accountId, a.secret, `commands/${id}/claim`)));
    expect(claims.map(r => r.json().execute).sort()).toEqual([false, true]);
    expect((await scriptRequest(a.accountId, a.secret, `commands/${id}/result`, { result: {} })).statusCode).toBe(400);
    expect((await scriptRequest(a.accountId, a.secret, `commands/${id}/result`, { result: { id: "sent1", threadId: "t" } })).statusCode).toBe(200);
    await scriptRequest(a.accountId, a.secret, `commands/${id}/result`, { result: { id: "forged", threadId: "other" } });
    expect(server.services.db.select().from(gmailScriptCommands).where(eq(gmailScriptCommands.id, id)).get()!.result).toEqual({ id: "sent1", threadId: "t" });
    expect((await scriptRequest(a.accountId, a.secret, `commands/${id}/claim`)).json().execute).toBe(false);
  });

  it("expires pending and interrupted commands without dispatching sends again", async () => {
    const { create, scriptRequest } = await setup();
    const a = await create();
    for (const status of ["pending", "claimed"]) {
      const id = server.services.gmailScript.enqueue(a.accountId, { operation: "PROFILE" });
      server.services.db.update(gmailScriptCommands).set({ status, expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(gmailScriptCommands.id, id)).run();
      expect((await scriptRequest(a.accountId, a.secret, "commands")).json().commands).toEqual([]);
      expect((await scriptRequest(a.accountId, a.secret, `commands/${id}/claim`)).json().execute).toBe(false);
      expect(server.services.db.select().from(gmailScriptCommands).where(eq(gmailScriptCommands.id, id)).get()!.status).toBe("failed");
    }
  });

  it("revokes old scripts immediately on reset and disconnect and enforces owner checks", async () => {
    const { auth, create, scriptRequest } = await setup();
    const a = await create();
    server.services.db.insert(users).values({ id: "other", name: "Other" }).run();
    const other = server.services.gmailScript.create("other");
    expect((await server.app.inject({ method: "POST", url: `/api/accounts/${other.accountId}/appscript/reset`, headers: auth })).statusCode).toBe(404);
    const reset = await server.app.inject({ method: "POST", url: `/api/accounts/${a.accountId}/appscript/reset`, headers: auth });
    expect(reset.statusCode).toBe(200);
    expect((await scriptRequest(a.accountId, a.secret, "commands")).statusCode).toBe(401);
    const secret = JSON.parse(reset.json().script.match(/const INTEGRATION_SECRET = (.*);/)[1]);
    expect((await scriptRequest(a.accountId, secret, "commands")).statusCode).toBe(200);
    const command = server.services.gmailScript.enqueue(a.accountId, { operation: "PROFILE" });
    await server.app.inject({ method: "DELETE", url: `/api/accounts/${a.accountId}`, headers: auth });
    expect((await scriptRequest(a.accountId, secret, "commands")).statusCode).toBe(401);
    expect(server.services.db.select().from(gmailScriptCommands).where(eq(gmailScriptCommands.id, command)).get()!.status).toBe("failed");
  });

  it("OAuth and Apps Script coexist and existing tools pick the script adapter", async () => {
    const { create, device, scriptRequest } = await setup();
    const oauth = await connectGmail(server, device.deviceToken);
    const a = await create();
    await scriptRequest(a.accountId, a.secret, "register", { address: "school@example.edu" });
    await scriptRequest(a.accountId, a.secret, "sync", { messages: [], cursor: "" });
    expect(server.services.integrations.list(server.services.owner.id).map(a => a.connectionMethod).sort()).toEqual(["appscript", "oauth"]);
    const client = gmailProviderFactory(server.services.integrations, server.google.fetch, server.services.gmailScript);
    expect(await client(oauth).profile()).toMatchObject({ emailAddress: "me@example.com" });
    const searched = client(a.accountId).search("from:friend", 5);
    const pending = (await scriptRequest(a.accountId, a.secret, "commands")).json().commands[0];
    expect(pending.input).toMatchObject({ operation: "SEARCH", query: "from:friend" });
    await scriptRequest(a.accountId, a.secret, `commands/${pending.id}/claim`);
    await scriptRequest(a.accountId, a.secret, `commands/${pending.id}/result`, { result: [message] });
    expect(await searched).toEqual([message]);
    await server.services.gmailPoller.tick(); // OAuth poller skips script accounts.
    expect(server.services.integrations.getRow(a.accountId)!.status).toBe("connected");
    expect(server.services.registry.get("gmail.reply")).toBeDefined();
    expect(server.services.registry.get("gmail.modify")).toBeDefined();
    expect(server.services.registry.get("gmail.send_appscript")).toBeUndefined();
  });
});

describe("generated Apps Script safety", () => {
  it("setup deduplicates only Lou triggers, stores config, syncs, and removal preserves email", async () => {
    const { create } = await setup();
    const a = await create();
    const requests: string[] = [];
    const runtime = scriptRuntime(a.script, (path) => { requests.push(path); return path === "commands" ? { commands: [] } : { ok: true }; });
    runtime.run("setupLou(); setupLou();");
    expect(runtime.triggers).toHaveLength(1);
    expect(requests).toContain("register");
    expect(requests).toContain("sync");
    expect([...runtime.properties.values()].join()).toContain(a.secret);
    expect(runtime.sends).toBe(0);
    runtime.run("removeLou()");
    expect(runtime.triggers).toHaveLength(0);
    expect(runtime.properties.size).toBe(0);
    expect(runtime.sends).toBe(0);
  });

  it("never sends twice after a lost result response, replay, or an interrupted execution", async () => {
    const { create } = await setup();
    const a = await create();
    const transport = server.services.gmailScript;
    const command = transport.enqueue(a.accountId, { operation: "SEND", email: { to: ["friend@example.com"], subject: "Hi", body: "Hello" } });
    let loseResponse = true;
    const runtime = scriptRuntime(a.script, (path, body) => {
      if (path === "commands") return transport.pending(a.accountId);
      if (path.endsWith("/claim")) return transport.claim(a.accountId, path.split("/")[1]!);
      if (path.endsWith("/result")) {
        const result = transport.complete(a.accountId, path.split("/")[1]!, body.result, body.error);
        if (loseResponse) throw new Error("Network failed after server accepted result");
        return result;
      }
      return { ok: true };
    });
    // Save configuration without setup's immediate sync.
    runtime.run("louProperties().setProperty(louKey('config'), JSON.stringify({server:LOU_SERVER,id:INTEGRATION_ID,secret:INTEGRATION_SECRET,version:1}))");
    expect(() => runtime.run("louRunCommands(Date.now()+45000)")).toThrow("Cannot reach Lou");
    expect(runtime.sends).toBe(1);
    loseResponse = false;
    runtime.run("louRunCommands(Date.now()+45000); louRunCommands(Date.now()+45000)");
    expect(runtime.sends).toBe(1);
    expect(transport.claim(a.accountId, command).execute).toBe(false);
    const interrupted = transport.enqueue(a.accountId, { operation: "SEND", email: { to: ["friend@example.com"], subject: "Interrupted", body: "Hi" } });
    transport.claim(a.accountId, interrupted);
    runtime.properties.set(`LOU_${a.accountId}_command_${interrupted}`, JSON.stringify({ started: true }));
    runtime.run("louRunCommands(Date.now()+45000)");
    expect(runtime.sends).toBe(1);
    expect(server.services.db.select().from(gmailScriptCommands).where(eq(gmailScriptCommands.id, interrupted)).get()).toMatchObject({ status: "failed", error: expect.stringContaining("outcome unknown") });
  });
});
