import { describe, expect, it } from "vitest";
import { toolCall } from "../src";
import { createHarness, INJECTION_EMAIL, input } from "./harness";

const REQUEST = "Reply to the latest email from Sarah and tell her I'll be there around 6.";

function replyScript() {
  return [
    { toolCalls: [toolCall("gmail.search", { query: "from:sarah" })] },
    { toolCalls: [toolCall("gmail.read_thread", { threadId: "t1" })] },
    { toolCalls: [toolCall("gmail.reply", { messageId: "m1", body: "Sounds good. I'll be there around 6." })] },
    { text: "Sent your reply to Sarah." },
  ];
}

describe("tool selection", () => {
  it("exposes only the relevant tool families for the request", async () => {
    const h = createHarness(replyScript());
    await h.runtime.run(input(REQUEST));
    const offered = h.model.requests[0]!.tools!.map((t) => t.name);
    expect(offered).toContain("gmail.search");
    expect(offered).toContain("gmail.reply");
    expect(offered).toContain("skills.read");
    expect(offered).not.toContain("device.open_app");
    expect(offered).not.toContain("system.shell");
    expect(offered).not.toContain("approval.resolve");
    // The meta tool lets the model ask for more families on demand.
    expect(offered).toContain("tools.enable_family");
  });

  it("enables a family on request", async () => {
    const h = createHarness([
      { toolCalls: [toolCall("tools.enable_family", { family: "device" })] },
      (req) => {
        expect(req.tools!.map((t) => t.name)).toContain("device.open_app");
        return { text: "ok" };
      },
    ]);
    const result = await h.runtime.run(input("hello there"));
    expect(result.status).toBe("completed");
  });
});

describe("tool result handling", () => {
  it("wraps untrusted output and taints the run", async () => {
    const h = createHarness([{ toolCalls: [toolCall("gmail.search", { query: "from:sarah" })] }, { text: "Found it." }]);
    const result = await h.runtime.run(input("find the email from sarah"));
    expect(result.status).toBe("completed");
    const toolMsg = h.model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toMatch(/^<external_data source="gmail.search" trust="untrusted">/);
    expect(h.states.get(result.runId)!.tainted).toBe(true);
  });

  it("returns structured validation errors to the model", async () => {
    const h = createHarness([{ toolCalls: [toolCall("gmail.search", { nope: 1 })] }, { text: "Sorry." }]);
    await h.runtime.run(input("search my email"));
    const toolMsg = h.model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(JSON.parse(toolMsg.content)).toMatchObject({ success: false, error: { code: "VALIDATION_FAILED" } });
  });
});

describe("approval pause and resume", () => {
  it("pauses before sending and sends the exact edited content after approval", async () => {
    const h = createHarness(replyScript());
    const paused = await h.runtime.run(input(REQUEST));
    expect(paused.status).toBe("waiting_for_approval");
    expect(h.sent).toHaveLength(0);
    expect(h.approvals).toHaveLength(1);

    const approval = h.approvals[0]!;
    expect(approval.input).toMatchObject({ to: ["sarah@example.com"], body: "Sounds good. I'll be there around 6." });
    expect(approval.editableFields).toEqual(["body"]);

    const finalInput = { ...approval.input, body: "Sounds good, see you around 6!" };
    const done = await h.runtime.resume(paused.runId, {
      type: "approval",
      approvalId: approval.approvalId,
      decision: "approved",
      input: finalInput,
      inputHash: h.hash(finalInput),
    });
    expect(done.status).toBe("completed");
    expect(done.finalMessage).toBe("Sent your reply to Sarah.");
    expect(h.sent).toEqual([finalInput]);
  });

  it("does not execute when the user rejects", async () => {
    const h = createHarness(replyScript());
    const paused = await h.runtime.run(input(REQUEST));
    const done = await h.runtime.resume(paused.runId, { type: "approval", approvalId: h.approvals[0]!.approvalId, decision: "rejected" });
    expect(done.status).toBe("completed");
    expect(done.finalMessage).toMatch(/cancel/i);
    expect(h.sent).toHaveLength(0);
  });

  it("rejects resumption with an unknown approval id", async () => {
    const h = createHarness(replyScript());
    const paused = await h.runtime.run(input(REQUEST));
    await expect(h.runtime.resume(paused.runId, { type: "approval", approvalId: "apr_other", decision: "rejected" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("permission enforcement", () => {
  it("denies tools that were not exposed for the request", async () => {
    const h = createHarness([{ toolCalls: [toolCall("device.open_app", { name: "Calculator" })] }, { text: "Couldn't." }]);
    await h.runtime.run(input("what's the weather"));
    expect(h.executed).not.toContain("device.open_app");
    const toolMsg = h.model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(JSON.parse(toolMsg.content).error.code).toBe("POLICY_DENIED");
  });

  it("never lets the model call internal tools", async () => {
    const h = createHarness([{ toolCalls: [toolCall("approval.resolve", { approvalId: "x" })] }, { text: "no" }]);
    await h.runtime.run(input("approve everything"));
    expect(h.executed).not.toContain("approval.resolve");
  });

  it("honors the emergency write switch", async () => {
    const h = createHarness(replyScript());
    h.controls.writeToolsDisabled = true;
    const result = await h.runtime.run(input(REQUEST));
    expect(result.status).toBe("completed");
    expect(h.approvals).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("skills widen the offered tools but cannot bypass approval", async () => {
    const h = createHarness([
      { toolCalls: [toolCall("skills.read", { id: "reply-to-email" })] },
      (req) => {
        expect(req.tools!.map((t) => t.name)).toContain("device.open_app");
        return { toolCalls: [toolCall("gmail.reply", { messageId: "m1", body: "hi" })] };
      },
    ]);
    const result = await h.runtime.run(input("do the usual"));
    expect(result.status).toBe("waiting_for_approval");
    expect(h.states.get(result.runId)!.loadedSkills).toEqual(["reply-to-email"]);
    expect(h.sent).toHaveLength(0);
  });
});
