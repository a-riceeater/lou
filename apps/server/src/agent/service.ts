import type { AgentInput, AgentRuntime, ContextProvider, ProgressSink, RunContext, RunState } from "@lou/agent";
import type { CreateRunRequest } from "@lou/protocol";
import { LouError, newId } from "@lou/shared";
import type { ApprovalDecision, ApprovalManager } from "../approvals/manager";
import type { AuditLog } from "../core/audit";
import type { EventBus } from "../core/bus";
import type { SettingsStore } from "../core/settings";
import type { UserStore } from "../core/users";
import type { DeviceGateway } from "../devices/gateway";
import type { DeviceRegistry } from "../devices/registry";
import type { IntegrationManager } from "../integrations/manager";
import type { Logger } from "../logger";
import type { MemoryStore } from "../memory/store";
import type { SkillRegistry } from "../skills/registry";
import type { WorkflowEngine } from "../workflows/engine";
import type { ConversationStore } from "./conversations";

export interface AgentServiceDeps {
  runtime: () => AgentRuntime;
  conversations: ConversationStore;
  approvals: ApprovalManager;
  workflows: WorkflowEngine;
  settings: SettingsStore;
  audit: AuditLog;
  bus: EventBus;
  logger: Logger;
  onRunCompleted?: (state: RunState) => void;
}

/**
 * Orchestrates agent runs for the HTTP/WS layer: starts runs asynchronously,
 * routes approval decisions back to the paused run (or workflow), and records
 * the conversation and audit trail. Independent of the runtime implementation.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {
    deps.approvals.onDecision((d) => this.onApprovalDecision(d));
  }

  start(userId: string, deviceId: string | undefined, req: CreateRunRequest): { runId: string; conversationId: string } {
    if (this.deps.settings.get().agentPaused) throw new LouError("POLICY_DENIED", "The assistant is paused. Resume it in Settings.");
    const conversationId = this.deps.conversations.getOrCreate(userId, req.conversationId);
    const runId = newId("run");
    this.deps.conversations.add(conversationId, "user", req.text, runId);
    this.deps.audit.record({ userId, actorType: deviceId ? "device" : "user", actorId: deviceId ?? userId, action: "run.started", targetType: "run", targetId: runId, runId, details: { inputMode: req.inputMode ?? "text" } });

    const input: AgentInput = { runId, userId, conversationId, text: req.text, source: "user", originDeviceId: deviceId };
    void this.deps
      .runtime()
      .run(input)
      .catch((err) => this.deps.logger.error({ err, runId }, "agent run crashed"));
    return { runId, conversationId };
  }

  async cancel(userId: string, runId: string, actorDeviceId?: string): Promise<void> {
    await this.deps.runtime().cancel(runId);
    await this.deps.approvals.cancelForRun(runId);
    this.deps.audit.record({ userId, actorType: "device", actorId: actorDeviceId, action: "run.cancelled", targetType: "run", targetId: runId, runId });
  }

  /** ProgressSink: fans run state out over the bus and finalizes history. */
  progressSink(): ProgressSink {
    return {
      progress: (state, label) => this.deps.bus.emit("run.progress", { userId: state.userId, runId: state.runId, status: state.status, label }),
      completed: (state) => {
        if (state.finalMessage) this.deps.conversations.add(state.conversationId, "assistant", state.finalMessage, state.runId);
        this.deps.audit.record({
          userId: state.userId,
          actorType: "agent",
          action: `run.${state.status}`,
          targetType: "run",
          targetId: state.runId,
          runId: state.runId,
          details: { model: state.model, steps: state.step, skills: state.loadedSkills, actionsTaken: state.actionsTaken, error: state.error?.code },
        });
        this.deps.bus.emit("run.completed", { userId: state.userId, runId: state.runId, status: state.status, message: state.finalMessage, error: state.error });
        this.deps.onRunCompleted?.(state);
      },
    };
  }

  private async onApprovalDecision(d: ApprovalDecision): Promise<void> {
    if (d.workflowRunId) {
      void this.deps.workflows.resumeAfterApproval(d.workflowRunId, d).catch((err) => this.deps.logger.error({ err, approvalId: d.approvalId }, "workflow resume failed"));
      return;
    }
    if (!d.runId) return;
    const continuation =
      d.decision === "approved"
        ? { type: "approval" as const, approvalId: d.approvalId, decision: "approved" as const, input: d.input!, inputHash: d.inputHash! }
        : { type: "approval" as const, approvalId: d.approvalId, decision: d.decision };
    // Resume asynchronously: the HTTP request returns immediately; progress streams over WebSocket.
    void this.deps
      .runtime()
      .resume(d.runId, continuation)
      .catch((err) => this.deps.logger.error({ err, runId: d.runId }, "agent resume failed"));
  }
}

/** Builds compact per-run context: memories, skill index, accounts, devices, history. */
export class ServerContextProvider implements ContextProvider {
  constructor(
    private readonly users: UserStore,
    private readonly memory: MemoryStore,
    private readonly skills: SkillRegistry,
    private readonly integrations: IntegrationManager,
    private readonly devices: DeviceRegistry,
    private readonly gateway: DeviceGateway,
    private readonly conversations: ConversationStore,
  ) {}

  async build(input: AgentInput): Promise<RunContext> {
    const user = this.users.get(input.userId);
    const memories = await this.memory.search(input.userId, input.text, 6);
    return {
      userName: user?.name ?? "the user",
      timezone: user?.timezone ?? "UTC",
      now: new Date(),
      memories: memories.map((m) => ({ type: m.type, content: m.content, source: m.source })),
      skills: this.skills.search(input.text, 4),
      accounts: this.integrations
        .list(input.userId)
        .filter((a) => a.provider !== "mcp")
        .map((a) => ({ id: a.id, provider: a.provider === "google" ? "gmail" : a.provider, address: a.address, displayName: a.displayName, status: a.status })),
      devices: this.devices
        .list(input.userId, (id) => this.gateway.isOnline(id), input.originDeviceId)
        .filter((d) => d.status === "active")
        .map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: d.online, current: d.current })),
      history: this.conversations.recent(input.conversationId, 6, input.runId),
      families: [],
    };
  }
}
