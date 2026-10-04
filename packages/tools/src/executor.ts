import { fail, ok, toLouError, type Result, type RiskLevel, type SerializedError } from "@lou/shared";
import type { z } from "zod";
import type { ApprovalGrant, EmergencyControls, TargetDevice, ToolPolicyEngine } from "./policy";
import type { ToolRegistry } from "./registry";
import type { AnyToolDefinition, ApprovalPresentation, ToolExecutionContext } from "./types";

export interface ApprovalCreateRequest {
  userId: string;
  runId?: string;
  toolCallId?: string;
  toolId: string;
  /** Prepared, complete input that will execute if approved unchanged. */
  input: Record<string, unknown>;
  inputHash: string;
  presentation: ApprovalPresentation;
  editableFields: readonly string[];
  risk: RiskLevel;
  reasons: string[];
  tainted: boolean;
}

export interface ToolCallRecord {
  id: string;
  runId?: string;
  toolId: string;
  input: unknown;
  risk: RiskLevel;
  executionTarget: "server" | "device";
  deviceId?: string;
  approvalId?: string;
}

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  policy: ToolPolicyEngine;
  controls(): EmergencyControls | Promise<EmergencyControls>;
  /** Resolves which device a device tool targets; undefined when none is usable. */
  resolveDevice(userId: string, requestedDeviceId: string | undefined, originDeviceId: string | undefined): Promise<TargetDevice | undefined>;
  createApproval(req: ApprovalCreateRequest): Promise<{ approvalId: string }>;
  hash(value: unknown): string;
  newId(prefix: string): string;
  /** Persists tool calls for history/audit. */
  recorder?: {
    started(record: ToolCallRecord): Promise<void> | void;
    finished(id: string, outcome: { status: "succeeded" | "failed" | "denied" | "awaiting_approval"; output?: unknown; error?: SerializedError; approvalId?: string }): Promise<void> | void;
  };
  /** Default per-call timeout. */
  timeoutMs?: number;
}

export interface InvokeRequest {
  toolId: string;
  rawInput: unknown;
  caller: "model" | "workflow" | "system";
  userId: string;
  runId?: string;
  originDeviceId?: string;
  exposedToolIds?: ReadonlySet<string>;
  tainted: boolean;
  /** Present when resuming after the user approved this exact (final) input. */
  grant?: ApprovalGrant;
  signal: AbortSignal;
}

export type InvokeOutcome =
  | { kind: "result"; toolCallId: string; result: Result<unknown>; definition: AnyToolDefinition }
  | { kind: "approval_required"; toolCallId: string; approvalId: string; definition: AnyToolDefinition }
  | { kind: "denied"; toolCallId: string; error: SerializedError; definition?: AnyToolDefinition };

/**
 * The single choke point for tool execution. Every call — from the model, a
 * workflow, or system code — passes schema validation and the policy engine here.
 */
export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  async invoke(req: InvokeRequest): Promise<InvokeOutcome> {
    const toolCallId = this.deps.newId("tc");
    const definition = this.deps.registry.get(req.toolId);
    if (!definition) {
      return { kind: "denied", toolCallId, error: err("NOT_FOUND", `Unknown tool "${req.toolId}".`) };
    }

    // Approved actions are validated against the prepared schema (which includes
    // server-derived fields); model input against the narrower model schema, which
    // strips any derived fields the model tried to supply.
    const schema: z.ZodType = req.grant ? (definition.preparedInput ?? definition.input) : definition.input;
    const parsed = schema.safeParse(req.rawInput ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return { kind: "result", toolCallId, definition, result: fail(err("VALIDATION_FAILED", `Invalid input for ${definition.id}: ${message}`)) };
    }
    let input = parsed.data as Record<string, unknown>;

    let device: TargetDevice | undefined;
    if (definition.executionTarget === "device") {
      device = await this.deps.resolveDevice(req.userId, input.deviceId as string | undefined, req.originDeviceId);
      // Pin the concrete device into the input so approvals and hashes cover it.
      if (device) input = { ...input, deviceId: device.id };
    }

    const inputHash = this.deps.hash(input);
    const decision = this.deps.policy.evaluate({
      tool: definition,
      toolId: definition.id,
      inputHash,
      caller: req.caller,
      exposedToolIds: req.exposedToolIds,
      tainted: req.tainted,
      controls: await this.deps.controls(),
      grant: req.grant,
      device,
    });

    const record: ToolCallRecord = {
      id: toolCallId,
      runId: req.runId,
      toolId: definition.id,
      input,
      risk: definition.risk,
      executionTarget: definition.executionTarget,
      deviceId: device?.id,
      approvalId: req.grant?.approvalId,
    };
    await this.deps.recorder?.started(record);

    if (decision.kind === "deny") {
      const error = err(decision.code, decision.reason);
      await this.deps.recorder?.finished(toolCallId, { status: "denied", error });
      return { kind: "denied", toolCallId, error, definition };
    }

    const handler = this.deps.registry.handler(definition.id);
    const ctx: ToolExecutionContext = {
      userId: req.userId,
      runId: req.runId,
      originDeviceId: req.originDeviceId,
      approvalId: req.grant?.approvalId,
      signal: req.signal,
    };

    if (decision.kind === "require_approval") {
      try {
        const prepared = handler.prepare
          ? await handler.prepare(input, ctx)
          : { input, presentation: genericPresentation(definition, input) };
        const preparedInput = prepared.input as Record<string, unknown>;
        const { approvalId } = await this.deps.createApproval({
          userId: req.userId,
          runId: req.runId,
          toolCallId,
          toolId: definition.id,
          input: preparedInput,
          inputHash: this.deps.hash(preparedInput),
          presentation: prepared.presentation,
          editableFields: definition.editableFields ?? [],
          risk: definition.risk,
          reasons: decision.reasons,
          tainted: req.tainted,
        });
        await this.deps.recorder?.finished(toolCallId, { status: "awaiting_approval", approvalId });
        return { kind: "approval_required", toolCallId, approvalId, definition };
      } catch (e) {
        const error = toLouError(e).toJSON();
        await this.deps.recorder?.finished(toolCallId, { status: "failed", error });
        return { kind: "result", toolCallId, definition, result: fail(error) };
      }
    }

    try {
      const output = await withTimeout(handler.execute(input, ctx), this.deps.timeoutMs ?? 60_000, req.signal);
      await this.deps.recorder?.finished(toolCallId, { status: "succeeded", output });
      return { kind: "result", toolCallId, definition, result: ok(output) };
    } catch (e) {
      const error = toLouError(e, "UPSTREAM_ERROR").toJSON();
      await this.deps.recorder?.finished(toolCallId, { status: "failed", error });
      return { kind: "result", toolCallId, definition, result: fail(error) };
    }
  }
}

function err(code: SerializedError["code"], message: string): SerializedError {
  return { code, message, retryable: false };
}

function genericPresentation(def: AnyToolDefinition, input: Record<string, unknown>): ApprovalPresentation {
  return {
    kind: "generic",
    title: def.title,
    summary: def.description,
    fields: Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({
        key,
        label: key,
        value: typeof value === "string" ? value : JSON.stringify(value),
        kind: typeof value === "string" && value.length > 80 ? ("longtext" as const) : ("text" as const),
      })),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(toLouError(Object.assign(new Error("The tool timed out."), { name: "TimeoutError" }), "TIMEOUT")), ms);
        onAbort = () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
