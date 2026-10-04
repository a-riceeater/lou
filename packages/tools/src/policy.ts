import type { ErrorCode } from "@lou/shared";
import type { AnyToolDefinition } from "./types";

/** Server-wide emergency switches (SECURITY.md §12). */
export interface EmergencyControls {
  writeToolsDisabled: boolean;
  deviceControlDisabled: boolean;
  agentPaused: boolean;
}

/** Proof that the user approved this exact tool call. */
export interface ApprovalGrant {
  approvalId: string;
  toolId: string;
  /** sha256 of the canonical JSON of the final, approved input. */
  inputHash: string;
}

export interface TargetDevice {
  id: string;
  online: boolean;
  capabilities: readonly string[];
}

export interface PolicyRequest {
  tool: AnyToolDefinition | undefined;
  toolId: string;
  /** sha256 of the canonical JSON of the input that would execute. */
  inputHash: string;
  caller: "model" | "workflow" | "system";
  /** Tools offered to the model for this run. Model calls outside this set are denied. */
  exposedToolIds?: ReadonlySet<string>;
  /** The run has ingested external, untrusted content. */
  tainted: boolean;
  controls: EmergencyControls;
  grant?: ApprovalGrant;
  device?: TargetDevice;
}

export type PolicyDecision =
  | { kind: "allow"; reasons: string[] }
  | { kind: "require_approval"; reasons: string[] }
  | { kind: "deny"; code: ErrorCode; reason: string };

/**
 * Decides whether a requested tool call may run. This is deterministic code
 * outside the model: the model can *request* a call, but only this engine (with
 * registry metadata and server settings) decides. Rules can only escalate the
 * requirement set by tool metadata, never relax it.
 */
export class ToolPolicyEngine {
  evaluate(req: PolicyRequest): PolicyDecision {
    const { tool } = req;
    if (!tool) return deny("NOT_FOUND", `Unknown tool "${req.toolId}".`);

    if (req.controls.agentPaused && req.caller !== "system") {
      return deny("POLICY_DENIED", "The assistant is paused.");
    }
    if (tool.exposure === "internal" && req.caller === "model") {
      return deny("POLICY_DENIED", `Tool "${tool.id}" is not available to the model.`);
    }
    if (req.caller === "model" && !req.exposedToolIds?.has(tool.id)) {
      return deny("POLICY_DENIED", `Tool "${tool.id}" is not enabled for this request.`);
    }
    if (req.controls.writeToolsDisabled && tool.risk !== "read") {
      return deny("POLICY_DENIED", "Write actions are disabled.");
    }

    if (tool.executionTarget === "device") {
      if (req.controls.deviceControlDisabled) return deny("POLICY_DENIED", "Device control is disabled.");
      if (!req.device) return deny("DEVICE_OFFLINE", "No device is available for this action.");
      if (tool.allowedDevices && !tool.allowedDevices.includes(req.device.id)) {
        return deny("FORBIDDEN", `Tool "${tool.id}" is not allowed on this device.`);
      }
      if (tool.capability && !req.device.capabilities.includes(tool.capability)) {
        return deny("FORBIDDEN", `The device does not support "${tool.capability}".`);
      }
      if (!req.device.online) return deny("DEVICE_OFFLINE", "The device is offline.");
    }

    // Privileged actions are never proposed off the back of external content.
    if (tool.risk === "privileged" && req.tainted) {
      return deny("POLICY_DENIED", "Privileged actions are blocked after reading external content.");
    }

    const reasons: string[] = [];
    if (tool.requiresApproval) reasons.push("tool_requires_approval");
    if (tool.risk === "destructive" || tool.risk === "privileged") reasons.push(`risk_${tool.risk}`);
    if (req.tainted && tool.risk !== "read") reasons.push("tainted_context");

    if (reasons.length === 0) return { kind: "allow", reasons: [] };

    if (req.grant) {
      if (req.grant.toolId !== tool.id || req.grant.inputHash !== req.inputHash) {
        return deny("APPROVAL_MISMATCH", "The action differs from what was approved.");
      }
      return { kind: "allow", reasons: ["approved", ...reasons] };
    }
    return { kind: "require_approval", reasons };
  }
}

function deny(code: ErrorCode, reason: string): PolicyDecision {
  return { kind: "deny", code, reason };
}
