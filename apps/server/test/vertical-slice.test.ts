import { toolCall } from "@lou/agent";
import { afterEach, describe, expect, it } from "vitest";
import { connectGmail, mimeBody, mimeHeader, pairDevice, startTestServer, waitForBus, type TestServer } from "./helpers";

const REQUEST = "Reply to the latest email from Sarah and tell her I'll be there around 6.";

function seedSarah(server: TestServer) {
  server.google.messages.push(
    { id: "m-old", threadId: "t-old", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Lunch", body: "Lunch next week?", date: "2026-09-01T10:00:00Z", messageId: "<old@mail>" },
    { id: "m-new", threadId: "t-new", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Dinner tonight", body: "Are you coming tonight? What time?", date: "2026-10-03T09:00:00Z", messageId: "<new@mail>" },
    { id: "m-bob", threadId: "t-bob", from: "Bob <bob@example.com>", to: "me@example.com", subject: "Hi", body: "Hello", date: "2026-10-03T11:00:00Z", messageId: "<bob@mail>" },
  );
}

/** The model's side of the vertical slice, asserting on what it is shown. */
function lunaScript() {
  return [
    (req: any) => {
      const tools = req.tools.map((t: any) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["gmail.search", "gmail.read_thread", "gmail.reply"]));
      expect(tools.some((t: string) => t.startsWith("device."))).toBe(false);
      return { toolCalls: [toolCall("gmail.search", { query: "from:sarah" })] };
    },
    (req: any) => {
      const result = req.messages.at(-1).content as string;
      expect(result).toContain('<external_data source="gmail.search"');
      expect(result).toContain("m-new");
      return { toolCalls: [toolCall("gmail.read_thread", { threadId: "t-new" })] };
    },
    { toolCalls: [toolCall("gmail.reply", { messageId: "m-new", body: "Sounds good. I'll be there around 6." })] },
    { text: "Sent your reply to Sarah." },
  ];
}

let server: TestServer;
afterEach(async () => server?.close());

describe("Gmail vertical slice", () => {
  it("finds the email, drafts, waits for approval, sends the exact edited reply, and records history + audit", async () => {
    server = await startTestServer({ steps: lunaScript() });
    seedSarah(server);
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    const accountId = await connectGmail(server, device.deviceToken);
    expect(accountId).toMatch(/^acc_/);

    const approvalRequested = waitForBus(server.services, "approval.requested");
    const start = await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: REQUEST } });
    expect(start.statusCode).toBe(202);
    const { runId } = start.json();

    const failed = waitForBus(server.services, "run.completed").then((e) => { throw new Error(`run ended: ${JSON.stringify(e)}`); });
    const { approval } = await Promise.race([approvalRequested, failed]);
    expect(approval.kind).toBe("email.reply");
    expect(approval.title).toBe("Reply to Sarah");
    expect(approval.fields.find((f: any) => f.key === "to").value).toBe("sarah@example.com");
    expect(approval.fields.find((f: any) => f.key === "subject").value).toBe("Re: Dinner tonight");
    const bodyField = approval.fields.find((f: any) => f.key === "body");
    expect(bodyField).toMatchObject({ editable: true, value: "Sounds good. I'll be there around 6." });
    expect(approval.fields.find((f: any) => f.key === "to").editable).toBe(false);

    // Nothing has been sent yet.
    expect(server.google.sent).toHaveLength(0);
    const runWhilePaused = await server.app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth });
    expect(runWhilePaused.json()).toMatchObject({ status: "waiting_for_approval", approvalId: approval.id });

    const edited = "Sounds good! I'll be there around 6:15.";
    const completed = waitForBus(server.services, "run.completed", (e) => e.runId === runId);
    const executed = waitForBus(server.services, "approval.resolved", (e) => e.approvalId === approval.id && e.status === "executed");
    const resolve = await server.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/resolve`,
      headers: auth,
      payload: { decision: "approve", actionHash: approval.actionHash, edits: { body: edited } },
    });
    expect(resolve.statusCode).toBe(200);
    await executed;
    const done = await completed;
    expect(done).toMatchObject({ status: "completed", message: "Sent your reply to Sarah." });

    // Exactly the approved, edited reply left the server, threaded correctly.
    expect(server.google.sent).toHaveLength(1);
    const sent = server.google.sent[0]!;
    expect(mimeBody(sent.decoded)).toBe(edited);
    expect(mimeHeader(sent.decoded, "To")).toBe("sarah@example.com");
    expect(mimeHeader(sent.decoded, "Subject")).toBe("Re: Dinner tonight");
    expect(mimeHeader(sent.decoded, "In-Reply-To")).toBe("<new@mail>");
    expect(sent.threadId).toBe("t-new");
    // The OAuth token never appears anywhere the model saw.
    for (const req of server.model.requests) expect(JSON.stringify(req)).not.toContain("access-1");

    const history = await server.app.inject({ method: "GET", url: "/api/history", headers: auth });
    expect(history.json().items[0]).toMatchObject({ runId, outcome: "action_taken", status: "completed" });

    const audit = (await server.app.inject({ method: "GET", url: `/api/audit?runId=${runId}`, headers: auth })).json().items.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["run.started", "approval.created", "approval.approved", "tool.executed", "approval.executed", "run.completed"]));
    const approved = (await server.app.inject({ method: "GET", url: `/api/approvals/${approval.id}`, headers: auth })).json();
    expect(approved.status).toBe("executed");

    const run = (await server.app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth })).json();
    expect(run.steps.map((s: any) => [s.toolId, s.status])).toEqual([
      ["gmail.search", "succeeded"],
      ["gmail.read_thread", "succeeded"],
      ["gmail.reply", "awaiting_approval"],
      ["gmail.reply", "succeeded"],
    ]);
  });

  it("cancel rejects the approval and sends nothing", async () => {
    server = await startTestServer({ steps: lunaScript().slice(0, 3) });
    seedSarah(server);
    const device = await pairDevice(server);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    await connectGmail(server, device.deviceToken);
    const requested = waitForBus(server.services, "approval.requested");
    const { runId } = (await server.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: REQUEST } })).json();
    const { approval } = await requested;
    const completed = waitForBus(server.services, "run.completed", (e) => e.runId === runId);
    const res = await server.app.inject({ method: "POST", url: `/api/approvals/${approval.id}/resolve`, headers: auth, payload: { decision: "reject", actionHash: approval.actionHash } });
    expect(res.json().status).toBe("rejected");
    expect((await completed).message).toMatch(/cancel/i);
    expect(server.google.sent).toHaveLength(0);
    const history = (await server.app.inject({ method: "GET", url: "/api/history", headers: auth })).json();
    expect(history.items[0].outcome).toBe("cancelled");
  });

  it("refreshes an expired access token transparently", async () => {
    server = await startTestServer({ steps: [{ toolCalls: [toolCall("gmail.search", { query: "from:sarah" })] }, { text: "Found it." }] });
    seedSarah(server);
    const device = await pairDevice(server);
    await connectGmail(server, device.deviceToken);
    server.google.failNextWith401 = true;
    const completed = waitForBus(server.services, "run.completed");
    await server.app.inject({ method: "POST", url: "/api/runs", headers: { authorization: `Bearer ${device.deviceToken}` }, payload: { text: "find sarah's email" } });
    expect((await completed).status).toBe("completed");
    expect(server.google.tokenRequests.map((r) => r.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
  });
});
