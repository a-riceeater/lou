import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { codexLog, connectGmail, mimeBody, mimeHeader, pairDevice, startTestServer, waitForBus, type TestServer } from "./helpers";

let server: TestServer;
afterEach(async () => server?.close());

const REQUEST = "Reply to the latest email from Sarah and tell her I'll be there around 6.";

function seed(s: TestServer) {
  s.google.messages.push({ id: "m-new", threadId: "t-new", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Dinner tonight", body: "Are you coming tonight?", date: "2026-10-03T09:00:00Z", messageId: "<new@mail>" });
}

async function useCodex(s: TestServer, token: string) {
  const res = await s.app.inject({ method: "PATCH", url: "/api/settings", headers: { authorization: `Bearer ${token}` }, payload: { aiProvider: "codex_cli" } });
  expect(res.json().aiProvider).toBe("codex_cli");
}

describe("Codex CLI provider (mock App Server)", () => {
  it("runs the Gmail vertical slice through Codex with Lou's approval flow", { timeout: 20_000 }, async () => {
    server = await startTestServer({
      codexScript: {
        turns: [
          [
            { tool: "gmail__search", args: { query: "from:sarah" } },
            { tool: "gmail__read_thread", args: { threadId: "t-new" } },
            { tool: "gmail__reply", args: { messageId: "m-new", body: "Sounds good. I'll be there around 6." } },
            { text: "Your reply to Sarah is ready for review." },
          ],
          [{ text: "Sent your reply to Sarah." }],
          [{ text: "You're welcome!" }],
        ],
      },
    });
    seed(server);
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    await connectGmail(server, device.deviceToken);
    await useCodex(server, device.deviceToken);

    const deltas: string[] = [];
    server.services.bus.on("run.delta", (e) => deltas.push(e.text));
    const requested = waitForBus(server.services, "approval.requested");
    const { runId, conversationId } = (await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: REQUEST } })).json();
    const { approval } = await requested;
    expect(approval.title).toBe("Reply to Sarah");
    expect(server.google.sent).toHaveLength(0);
    // The OpenAI API model was never used.
    expect(server.model.callCount).toBe(0);

    const completed = waitForBus(server.services, "run.completed", (e) => e.runId === runId);
    await server.app.inject({ method: "POST", url: `/api/approvals/${approval.id}/resolve`, headers: auth, payload: { decision: "approve", actionHash: approval.actionHash, edits: { body: "Sounds good! See you around 6:15." } } });
    expect((await completed).message).toBe("Sent your reply to Sarah.");
    expect(deltas.join("")).toContain("Sent your reply to Sarah.");

    // Exactly the approved, edited content was sent.
    expect(server.google.sent).toHaveLength(1);
    expect(mimeBody(server.google.sent[0]!.decoded)).toBe("Sounds good! See you around 6:15.");
    expect(mimeHeader(server.google.sent[0]!.decoded, "To")).toBe("sarah@example.com");

    // History, audit and provider attribution.
    const history = (await server.app.inject({ method: "GET", url: "/api/history", headers: auth })).json().items;
    expect(history[0]).toMatchObject({ runId, outcome: "action_taken" });
    const audit = server.services.audit.list({ runId });
    expect(audit.find((e) => e.action === "run.started")?.details).toMatchObject({ provider: "codex_cli" });
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["approval.created", "approval.approved", "tool.executed", "approval.executed"]));
    expect(server.services.runs.providerOf(runId)).toBe("codex_cli");

    // A follow-up in the same conversation reuses the Codex thread.
    const follow = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "thanks", conversationId } });
    expect((await follow).message).toBe("You're welcome!");
    const log = codexLog(server);
    expect(log.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    const turnThreads = new Set(log.requests.filter((r) => r.method === "turn/start").map((r) => r.params.threadId));
    expect(turnThreads.size).toBe(1);
    // Codex was launched locked down.
    expect(log.launches.at(-1)!.join(" ")).toContain("--disable shell_tool");
  });

  it("switches providers without restarting and keeps each run with its own provider", async () => {
    server = await startTestServer({ steps: [{ text: "Hi from the API." }], codexScript: { turns: [[{ text: "Hi from Codex." }]] } });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };

    const apiDeltas: string[] = [];
    const offDelta = server.services.bus.on("run.delta", (e) => apiDeltas.push(e.text));
    let done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    expect((await done).message).toBe("Hi from the API.");
    // The API provider streams too.
    expect(apiDeltas.join("")).toBe("Hi from the API.");
    offDelta();

    await useCodex(server, device.deviceToken);
    done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    expect((await done).message).toBe("Hi from Codex.");
    expect(server.services.audit.list({ limit: 100 }).some((e) => e.action === "settings.changed" && (e.details as any).aiProvider === "codex_cli")).toBe(true);

    const providers = (await server.app.inject({ method: "GET", url: "/api/providers", headers: auth })).json();
    expect(providers.active).toBe("codex_cli");
    const codex = providers.items.find((p: any) => p.id === "codex_cli");
    expect(codex).toMatchObject({ state: "ready", summary: "Connected", active: true });
    expect(codex.details).toMatchObject({ Authentication: "ChatGPT (plus)", CLI: "installed (9.9.9-mock)" });
    expect(JSON.stringify(providers)).not.toContain("user@example.com");
  });

  it("explains an unauthenticated Codex and offers the API explicitly instead of switching", async () => {
    server = await startTestServer({ steps: [{ text: "Answered by the API." }], codexScript: { auth: "none" } });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    await useCodex(server, device.deviceToken);

    const status = (await server.app.inject({ method: "GET", url: "/api/providers?probe=1", headers: auth })).json().items.find((p: any) => p.id === "codex_cli");
    expect(status).toMatchObject({ state: "not_signed_in", summary: "Not signed in", hint: "Run: codex login" });

    const failed = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    const result = await failed;
    expect(result.status).toBe("failed");
    expect(result.error.message).toMatch(/codex login/);
    expect(result.error.details).toMatchObject({ provider: "codex_cli", fallbackProvider: "openai_api" });
    expect(server.model.callCount).toBe(0); // no silent fallback

    // The user explicitly retries with the API; the override is audited.
    const retried = waitForBus(server.services, "run.completed");
    const { runId } = (await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello", provider: "openai_api" } })).json();
    expect((await retried).message).toBe("Answered by the API.");
    expect(server.services.audit.list({ runId }).find((e) => e.action === "run.started")?.details).toMatchObject({ provider: "openai_api", providerOverride: true });
  });

  it("reports a missing Codex executable", async () => {
    server = await startTestServer();
    const device = await pairDevice(server);
    const items = (await server.app.inject({ method: "GET", url: "/api/providers?probe=1", headers: { authorization: `Bearer ${device.deviceToken}` } })).json().items;
    expect(items.find((p: any) => p.id === "codex_cli")).toMatchObject({ state: "not_installed", summary: "Unavailable" });
    expect(items.find((p: any) => p.id === "codex_cli").hint).toMatch(/npm install -g @openai\/codex/);
  });

  it("streams Codex text to devices over the WebSocket", async () => {
    server = await startTestServer({ codexScript: { turns: [[{ text: "Streaming works fine." }]] } });
    const device = await pairDevice(server);
    await useCodex(server, device.deviceToken);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${device.deviceToken}` } });
    const frames: any[] = [];
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ v: 1, id: "h", ts: new Date().toISOString(), type: "device.hello", payload: { platform: "windows", clientVersion: "t", capabilities: [] } }));
    await new Promise((r) => setTimeout(r, 100));

    const done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: { authorization: `Bearer ${device.deviceToken}` }, payload: { text: "stream please" } });
    await done;
    await new Promise((r) => setTimeout(r, 50));
    const text = frames.filter((f) => f.type === "agent.delta").map((f) => f.payload.text).join("");
    expect(text).toBe("Streaming works fine.");
    expect(frames.find((f) => f.type === "agent.completed")?.payload.message).toBe("Streaming works fine.");
    ws.close();
  });
});
