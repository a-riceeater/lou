import { afterEach, describe, expect, it } from "vitest";
import { claudeLog, connectGmail, mimeBody, mimeHeader, pairDevice, startTestServer, waitForBus, type TestServer } from "./helpers";

let server: TestServer;
afterEach(async () => server?.close());

const REQUEST = "Reply to the latest email from Sarah and tell her I'll be there around 6.";
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

function seed(s: TestServer) {
  s.google.messages.push({ id: "m-new", threadId: "t-new", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Dinner tonight", body: "Are you coming tonight?", date: "2026-10-03T09:00:00Z", messageId: "<new@mail>" });
}

async function settings(s: TestServer, token: string, payload: Record<string, unknown>) {
  return s.app.inject({ method: "PATCH", url: "/api/settings", headers: { authorization: `Bearer ${token}` }, payload });
}

describe("Claude CLI provider (mock claude)", () => {
  it("runs the Gmail vertical slice through Claude Code with Lou's approval flow", { timeout: 30_000 }, async () => {
    server = await startTestServer({
      claudeScript: {
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
    expect((await settings(server, device.deviceToken, { aiProvider: "claude_cli" })).json().aiProvider).toBe("claude_cli");

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
    expect(audit.find((e) => e.action === "run.started")?.details).toMatchObject({ provider: "claude_cli" });
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["approval.created", "approval.approved", "tool.executed", "approval.executed"]));
    expect(server.services.runs.providerOf(runId)).toBe("claude_cli");

    // A follow-up in the same conversation resumes the same Claude Code session.
    const follow = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "thanks", conversationId } });
    expect((await follow).message).toBe("You're welcome!");
    const log = claudeLog(server);
    expect(new Set(log.turns.map((t) => t.sessionId)).size).toBe(1);
    expect(log.turns.slice(1).every((t) => t.resumed)).toBe(true);
    // Claude Code was launched locked down.
    const argv = log.launches.at(-1)!;
    expect(valueOf(argv, "--tools")).toBe("");
    expect(valueOf(argv, "--setting-sources")).toBe("");
    expect(argv).toContain("--strict-mcp-config");
  });

  it("switches providers, reports Claude Code's status and applies the model chosen in Settings", async () => {
    server = await startTestServer({ steps: [{ text: "Hi from the API." }], claudeScript: { turns: [[{ text: "Hi from Claude." }], [{ text: "Hi from Sonnet." }]] } });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };

    let done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    expect((await done).message).toBe("Hi from the API.");

    await settings(server, device.deviceToken, { aiProvider: "claude_cli" });
    done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    expect((await done).message).toBe("Hi from Claude.");
    expect(claudeLog(server).launches.at(-1)).not.toContain("--model");

    const providers = (await server.app.inject({ method: "GET", url: "/api/providers", headers: auth })).json();
    expect(providers.active).toBe("claude_cli");
    const claude = providers.items.find((p: any) => p.id === "claude_cli");
    expect(claude).toMatchObject({ label: "Claude Code", state: "ready", summary: "Connected", active: true });
    expect(claude.details).toMatchObject({ Authentication: "Claude subscription (max)", CLI: "installed (9.9.9)", Model: "Claude Code default", Sandbox: "locked down: Lou tools only" });
    expect(JSON.stringify(providers)).not.toMatch(/user@example\.com|org-secret/);

    // The model is a setting: validated, audited and used from the next request on.
    expect((await settings(server, device.deviceToken, { claudeModel: "--dangerously-skip-permissions" })).statusCode).toBe(400);
    expect((await settings(server, device.deviceToken, { claudeModel: "sonnet" })).json().claudeModel).toBe("sonnet");
    expect(server.services.audit.list({ limit: 100 }).some((e) => e.action === "settings.changed" && (e.details as any).claudeModel === "sonnet")).toBe(true);
    done = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello again" } });
    expect((await done).message).toBe("Hi from Sonnet.");
    expect(valueOf(claudeLog(server).launches.at(-1)!, "--model")).toBe("sonnet");
    expect(server.services.providers.modelLabel()).toBe("Claude Code (sonnet)");
    const me = (await server.app.inject({ method: "GET", url: "/api/me", headers: auth })).json();
    expect(me.model).toBe("Claude Code (sonnet)");
  });

  it("explains an unauthenticated Claude Code and offers the API explicitly instead of switching", async () => {
    server = await startTestServer({ steps: [{ text: "Answered by the API." }], claudeScript: { auth: "none" } });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    await settings(server, device.deviceToken, { aiProvider: "claude_cli" });

    const status = (await server.app.inject({ method: "GET", url: "/api/providers?probe=1", headers: auth })).json().items.find((p: any) => p.id === "claude_cli");
    expect(status).toMatchObject({ state: "not_signed_in", summary: "Not signed in", hint: "Run: claude auth login" });

    const failed = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    const result = await failed;
    expect(result.status).toBe("failed");
    expect(result.error.message).toMatch(/claude auth login/);
    expect(result.error.details).toMatchObject({ provider: "claude_cli", fallbackProvider: "openai_api" });
    expect(server.model.callCount).toBe(0); // no silent fallback

    const retried = waitForBus(server.services, "run.completed");
    const { runId } = (await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello", provider: "openai_api" } })).json();
    expect((await retried).message).toBe("Answered by the API.");
    expect(server.services.audit.list({ runId }).find((e) => e.action === "run.started")?.details).toMatchObject({ provider: "openai_api", providerOverride: true });
  });

  it("offers Claude Code as the explicit fallback when it's the usable alternative", async () => {
    server = await startTestServer({ apiModel: null, claudeScript: { turns: [[{ text: "Hi from Claude." }]] } });
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    await server.app.inject({ method: "GET", url: "/api/providers?probe=1", headers: auth });
    const failed = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello" } });
    expect((await failed).error.details).toMatchObject({ fallbackProvider: "claude_cli" });

    const retried = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "hello", provider: "claude_cli" } });
    expect((await retried).message).toBe("Hi from Claude.");
  });

  it("reports a missing Claude Code executable", async () => {
    server = await startTestServer();
    const device = await pairDevice(server);
    const items = (await server.app.inject({ method: "GET", url: "/api/providers?probe=1", headers: { authorization: `Bearer ${device.deviceToken}` } })).json().items;
    const claude = items.find((p: any) => p.id === "claude_cli");
    expect(claude).toMatchObject({ state: "not_installed", summary: "Unavailable" });
    expect(claude.hint).toMatch(/npm install -g @anthropic-ai\/claude-code/);
    const health = (await server.app.inject({ method: "GET", url: "/health" })).json();
    expect(health.claude).toBe("not_installed");
  });
});
