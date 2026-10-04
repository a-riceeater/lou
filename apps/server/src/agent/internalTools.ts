import { MEMORY_TYPES } from "@lou/protocol";
import { LouError } from "@lou/shared";
import { DEVICE_TOOLS, type ToolRegistry } from "@lou/tools";
import { z } from "zod";
import type { ApprovalManager } from "../approvals/manager";
import type { DeviceGateway } from "../devices/gateway";
import type { MemoryStore } from "../memory/store";
import type { SkillRegistry } from "../skills/registry";
import type { WorkflowEngine } from "../workflows/engine";

export interface InternalToolDeps {
  memory: MemoryStore;
  skills: SkillRegistry;
  approvals: ApprovalManager;
  workflows: WorkflowEngine;
  gateway: DeviceGateway;
}

/** Registers memory, skill, approval, workflow and device tools. */
export function registerInternalTools(registry: ToolRegistry, deps: InternalToolDeps): void {
  const server = { executionTarget: "server" as const, exposure: "model" as const };

  registry.register(
    {
      ...server,
      id: "memory.search",
      family: "core",
      title: "Checking memory",
      description: "Search remembered facts and preferences (contacts, account mappings, tone, routines).",
      input: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(10).optional() }),
      risk: "read",
      requiresApproval: false,
      untrustedOutput: false,
    },
    {
      async execute(input, ctx) {
        const results = await deps.memory.search(ctx.userId, input.query, input.limit ?? 5);
        return { memories: results.map((m) => ({ type: m.type, content: m.content, source: m.source })) };
      },
    },
  );

  registry.register(
    {
      ...server,
      id: "memory.save",
      family: "core",
      title: "Remembering",
      description: "Remember a stable fact or preference the user stated (never passwords or credentials).",
      input: z.object({ type: z.enum(MEMORY_TYPES), content: z.string().min(3).max(500) }),
      risk: "write",
      requiresApproval: false,
      untrustedOutput: false,
    },
    {
      async execute(input, ctx) {
        const m = await deps.memory.create({ userId: ctx.userId, type: input.type, content: input.content, source: "agent-inferred", confidence: 0.8, sourceRunId: ctx.runId }, { type: "agent" });
        return { saved: true, id: m.id };
      },
    },
  );

  registry.register(
    {
      ...server,
      id: "skills.search",
      family: "core",
      title: "Looking for a skill",
      description: "Find saved procedures (skills) relevant to a task. Returns ids and descriptions only.",
      input: z.object({ query: z.string().min(1).max(300) }),
      risk: "read",
      requiresApproval: false,
      untrustedOutput: false,
    },
    { execute: async (input) => ({ skills: deps.skills.search(input.query, 6) }) },
  );

  registry.register(
    {
      ...server,
      id: "skills.read",
      family: "core",
      title: "Reading a skill",
      description: "Load the full procedure of a skill by id before following it.",
      input: z.object({ id: z.string().min(1).max(64) }),
      risk: "read",
      requiresApproval: false,
      untrustedOutput: false,
    },
    { execute: async (input) => deps.skills.read(input.id) },
  );

  registry.register(
    {
      ...server,
      id: "workflow.list",
      family: "workflow",
      title: "Checking workflows",
      description: "List saved deterministic workflows with their required inputs.",
      input: z.object({}),
      risk: "read",
      requiresApproval: false,
      untrustedOutput: false,
    },
    {
      async execute() {
        return {
          workflows: deps.workflows
            .list()
            .filter((w) => w.enabled)
            .map((w) => ({ id: w.id, description: w.description, inputs: deps.workflows.definition(w.id)?.inputs ?? {} })),
        };
      },
    },
  );

  // The orchestrator itself is read-only; every step it runs is policy-checked
  // individually by the ToolExecutor, including approvals for consequential steps.
  registry.register(
    {
      ...server,
      id: "workflow.run",
      family: "workflow",
      title: "Running a workflow",
      description: "Run a saved workflow by id with its inputs. Steps that need approval pause for the user.",
      input: z.object({ workflowId: z.string(), inputs: z.record(z.string(), z.unknown()) }),
      risk: "read",
      requiresApproval: false,
      untrustedOutput: true,
    },
    {
      async execute(input, ctx) {
        const result = await deps.workflows.start({ userId: ctx.userId, workflowId: input.workflowId, inputs: input.inputs, agentRunId: ctx.runId, originDeviceId: ctx.originDeviceId, tainted: true, signal: ctx.signal });
        if (result.status === "failed") throw new LouError(result.error?.code ?? "INTERNAL", result.error?.message ?? "Workflow failed.");
        return result.status === "waiting_for_approval"
          ? { status: "waiting_for_approval", note: "The user has been shown the draft for approval." }
          : { status: result.status, output: result.output };
      },
    },
  );

  // Internal-only: never offered to the model (policy denies model calls to internal tools).
  registry.register(
    {
      ...server,
      exposure: "internal",
      id: "approval.resolve",
      family: "approval",
      title: "Resolving approval",
      description: "Resolve a pending approval. Only callable by user-authenticated system code.",
      input: z.object({ userId: z.string(), approvalId: z.string(), decision: z.enum(["approve", "reject"]), actionHash: z.string(), edits: z.record(z.string(), z.string()).optional(), deviceId: z.string().optional() }),
      risk: "privileged",
      requiresApproval: true,
      untrustedOutput: false,
    },
    {
      async execute(input) {
        return deps.approvals.resolve(input.userId, input.approvalId, { decision: input.decision, actionHash: input.actionHash, edits: input.edits }, { deviceId: input.deviceId });
      },
    },
  );

  registry.register(
    {
      ...server,
      exposure: "internal",
      id: "approval.create",
      family: "approval",
      title: "Requesting approval",
      description: "Create an approval request for a proposed tool call (used by system automation). Model-proposed actions get approvals automatically from policy.",
      input: z.object({ toolId: z.string(), input: z.record(z.string(), z.unknown()) }),
      risk: "write",
      requiresApproval: false,
      untrustedOutput: false,
    },
    {
      async execute() {
        throw new LouError("POLICY_DENIED", "Approvals are created by the policy engine when a gated tool is invoked.");
      },
    },
  );

  for (const def of DEVICE_TOOLS) {
    registry.register(def as never, {
      async execute(input: Record<string, unknown>, ctx) {
        const { deviceId, ...rest } = input;
        if (typeof deviceId !== "string") throw new LouError("DEVICE_OFFLINE", "No device available.");
        return deps.gateway.sendCommand(deviceId, def.id, rest, ctx.approvalId, ctx.signal);
      },
    });
  }
}
