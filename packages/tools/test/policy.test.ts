import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolPolicyEngine, ToolRegistry, deviceGetClipboard, deviceInvokeUiElement, selectFamilies, BUILTIN_FAMILIES, type PolicyRequest } from "../src";

const policy = new ToolPolicyEngine();
const controls = { writeToolsDisabled: false, deviceControlDisabled: false, agentPaused: false };

function req(overrides: Partial<PolicyRequest>): PolicyRequest {
  return {
    tool: deviceGetClipboard,
    toolId: deviceGetClipboard.id,
    inputHash: "h1",
    caller: "model",
    exposedToolIds: new Set([deviceGetClipboard.id, deviceInvokeUiElement.id]),
    tainted: false,
    controls,
    device: { id: "dev_1", online: true, capabilities: ["clipboard_read", "ui_automation"] },
    ...overrides,
  };
}

describe("ToolPolicyEngine", () => {
  it("allows exposed read tools", () => {
    expect(policy.evaluate(req({})).kind).toBe("allow");
  });

  it("denies when the device lacks the capability or is offline", () => {
    expect(policy.evaluate(req({ device: { id: "d", online: true, capabilities: [] } }))).toMatchObject({ kind: "deny", code: "FORBIDDEN" });
    expect(policy.evaluate(req({ device: { id: "d", online: false, capabilities: ["clipboard_read"] } }))).toMatchObject({
      kind: "deny",
      code: "DEVICE_OFFLINE",
    });
  });

  it("requires approval for approval-gated tools and accepts only a matching grant", () => {
    const base = req({ tool: deviceInvokeUiElement, toolId: deviceInvokeUiElement.id });
    expect(policy.evaluate(base).kind).toBe("require_approval");
    expect(policy.evaluate({ ...base, grant: { approvalId: "a", toolId: deviceInvokeUiElement.id, inputHash: "h1" } }).kind).toBe("allow");
    expect(policy.evaluate({ ...base, grant: { approvalId: "a", toolId: deviceInvokeUiElement.id, inputHash: "other" } })).toMatchObject({
      kind: "deny",
      code: "APPROVAL_MISMATCH",
    });
  });

  it("honors emergency controls", () => {
    expect(policy.evaluate(req({ controls: { ...controls, deviceControlDisabled: true } })).kind).toBe("deny");
    expect(policy.evaluate(req({ controls: { ...controls, agentPaused: true } })).kind).toBe("deny");
  });
});

describe("ToolRegistry", () => {
  it("freezes definitions so permissions cannot be mutated", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        id: "x.delete",
        family: "x",
        title: "Delete",
        description: "d",
        input: z.object({}),
        risk: "destructive",
        executionTarget: "server",
        requiresApproval: true,
        exposure: "model",
        untrustedOutput: false,
      },
      { execute: async () => ({}) },
    );
    const def = registry.require("x.delete") as { requiresApproval: boolean };
    expect(() => {
      def.requiresApproval = false;
    }).toThrow();
  });

  it("refuses destructive tools that skip approval", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(
        {
          id: "x.wipe",
          family: "x",
          title: "Wipe",
          description: "d",
          input: z.object({}),
          risk: "destructive",
          executionTarget: "server",
          requiresApproval: false,
          exposure: "model",
          untrustedOutput: false,
        },
        { execute: async () => ({}) },
      ),
    ).toThrow(/must require approval/);
  });
});

describe("selectFamilies", () => {
  it("picks gmail for an email reply and device for opening apps", () => {
    expect(selectFamilies("Reply to the latest email from Sarah", BUILTIN_FAMILIES)).toEqual(expect.arrayContaining(["core", "gmail"]));
    expect(selectFamilies("Reply to the latest email from Sarah", BUILTIN_FAMILIES)).not.toContain("device");
    expect(selectFamilies("open spotify", BUILTIN_FAMILIES)).toContain("device");
  });
});
