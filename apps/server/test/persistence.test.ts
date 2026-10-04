import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolCall } from "@lou/agent";
import { afterAll, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/security/crypto";
import { connectGmail, FakeGoogle, mimeBody, pairDevice, startTestServer, waitForBus } from "./helpers";

const dataDir = mkdtempSync(join(tmpdir(), "lou-persist-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("restart persistence", () => {
  it("an approval pending before a restart can be approved after it, and the run completes", async () => {
    const masterKey = generateMasterKey();
    const google = new FakeGoogle();
    google.messages.push({ id: "m1", threadId: "t1", from: "Sarah <sarah@example.com>", to: "me@example.com", subject: "Plans", body: "Coming?", date: "2026-10-03T09:00:00Z", messageId: "<m1@x>" });

    // --- First process: run until the approval is pending, then shut down.
    const first = await startTestServer({ dataDir, masterKey, google, steps: [{ toolCalls: [toolCall("gmail.reply", { messageId: "m1", body: "Yes, see you at 6." })] }] });
    const device = await pairDevice(first);
    const auth = { authorization: `Bearer ${device.deviceToken}` };
    await connectGmail(first, device.deviceToken);
    await first.services.memory.create({ userId: first.services.owner.id, type: "preference", content: "Keep replies short.", source: "user" }, { type: "user" });
    const requested = waitForBus(first.services, "approval.requested");
    const { runId } = (await first.app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "reply to sarah" } })).json();
    const { approval } = await requested;
    await first.close();

    // --- Second process on the same database: credentials, approval, run, memory, skills survive.
    const second = await startTestServer({ dataDir, masterKey, google, steps: [{ text: "Sent." }] });
    expect((await second.app.inject({ method: "GET", url: "/api/me", headers: auth })).statusCode).toBe(200);
    const pending = (await second.app.inject({ method: "GET", url: "/api/approvals?status=pending", headers: auth })).json().items;
    expect(pending.map((a: any) => a.id)).toEqual([approval.id]);
    expect(second.services.memory.list(second.services.owner.id).map((m) => m.content)).toContain("Keep replies short.");
    expect(second.services.skills.list().length).toBeGreaterThanOrEqual(5);

    const completed = waitForBus(second.services, "run.completed", (e) => e.runId === runId);
    await second.app.inject({ method: "POST", url: `/api/approvals/${approval.id}/resolve`, headers: auth, payload: { decision: "approve", actionHash: approval.actionHash } });
    expect((await completed).status).toBe("completed");
    expect(google.sent).toHaveLength(1);
    expect(mimeBody(google.sent[0]!.decoded)).toBe("Yes, see you at 6.");
    const history = (await second.app.inject({ method: "GET", url: "/api/history", headers: auth })).json().items;
    expect(history.find((h: any) => h.runId === runId).outcome).toBe("action_taken");
    await second.close();
  });
});
