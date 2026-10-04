import type { ExecutionTarget, RiskLevel } from "@lou/shared";
import type { ApprovalField } from "@lou/protocol";
import type { z } from "zod";

/**
 * Static, immutable description of a capability. Permissions (risk, approval,
 * allowed devices) live here and in server policy only — never in prompts, skills
 * or model output.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** Stable dotted ID, e.g. `gmail.search`. */
  readonly id: string;
  /** Tool family used for progressive disclosure, e.g. `gmail`, `device`. */
  readonly family: string;
  /** Short user-facing progress label, e.g. "Searching email". */
  readonly title: string;
  /** Model-facing description. */
  readonly description: string;
  /** Model-facing input schema. Unknown keys are stripped. */
  readonly input: z.ZodType<I>;
  /**
   * Schema for the prepared input of approval-gated tools: the model input plus
   * server-derived fields (recipients, thread IDs). Only approved actions are
   * validated against it, so the model can never supply derived fields itself.
   */
  readonly preparedInput?: z.ZodType<unknown>;
  readonly output?: z.ZodType<O>;
  /** Raw JSON Schema for the model when the input comes from an external source (e.g. MCP). */
  readonly inputJsonSchema?: Record<string, unknown>;
  readonly risk: RiskLevel;
  readonly executionTarget: ExecutionTarget;
  readonly requiresApproval: boolean;
  readonly allowedDevices?: readonly string[];
  /** `internal` tools are callable by workflows/system code but never offered to the model. */
  readonly exposure: "model" | "internal";
  /** True when the output may contain external content; it is wrapped as untrusted and taints the run. */
  readonly untrustedOutput: boolean;
  /** Device capability required to execute (device tools only). */
  readonly capability?: string;
  /** For approval-gated tools: top-level input keys the user may edit in the approval UI. */
  readonly editableFields?: readonly string[];
}

export type AnyToolDefinition = ToolDefinition<any, any>;

/** What the user sees in the approval UI, derived deterministically by server code. */
export interface ApprovalPresentation {
  kind: string;
  title: string;
  summary?: string;
  account?: string;
  fields: Array<Omit<ApprovalField, "editable">>;
}

export interface PreparedAction<I> {
  /**
   * The complete input that will be executed if approved. Server-derived values
   * (recipients, thread IDs, subjects) are frozen here so execution cannot drift
   * from what the user saw.
   */
  input: I;
  presentation: ApprovalPresentation;
}

export interface ToolExecutionContext {
  userId: string;
  runId?: string;
  /** Device that originated the request, if any. */
  originDeviceId?: string;
  approvalId?: string;
  signal: AbortSignal;
}

export interface ToolHandler<I = unknown, O = unknown> {
  execute(input: I, ctx: ToolExecutionContext): Promise<O>;
  /** Required for tools that can need approval: resolves derived fields and the presentation. */
  prepare?(input: I, ctx: ToolExecutionContext): Promise<PreparedAction<I>>;
  /** Re-validates an edited, approved input (e.g. body length) before execution. */
  applyEdits?(prepared: I, edits: Record<string, string>): I;
}

export type AnyToolHandler = ToolHandler<any, any>;

/** JSON-schema tool spec handed to a model provider. */
export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
