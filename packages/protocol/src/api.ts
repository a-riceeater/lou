import { z } from "zod";
import { ApprovalStatusSchema, ErrorDtoSchema, IsoDate, RiskLevelSchema, RunStatusSchema } from "./common";

// ---------------------------------------------------------------------------
// Devices & pairing
// ---------------------------------------------------------------------------

export const DevicePlatformSchema = z.enum(["windows", "macos", "ios", "web"]);

export const DeviceRegisterRequestSchema = z.object({
  pairingCode: z.string().min(4).max(32),
  name: z.string().min(1).max(80),
  platform: DevicePlatformSchema,
  clientVersion: z.string().max(40).optional(),
  capabilities: z.array(z.string().max(64)).max(64).default([]),
});
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequestSchema>;

export const DeviceRegisterResponseSchema = z.object({
  deviceId: z.string(),
  /** Bearer credential for HTTPS and WebSocket. Shown exactly once. */
  deviceToken: z.string(),
  /** Base64 HMAC key used to verify server-issued device commands. Shown exactly once. */
  commandKey: z.string(),
  userId: z.string(),
});
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponseSchema>;

export const DeviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: DevicePlatformSchema,
  status: z.enum(["active", "revoked"]),
  online: z.boolean(),
  capabilities: z.array(z.string()),
  lastSeenAt: IsoDate.nullable(),
  createdAt: IsoDate,
  current: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

export const PairingCodeResponseSchema = z.object({ code: z.string(), expiresAt: IsoDate });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

// ---------------------------------------------------------------------------
// Runs & history
// ---------------------------------------------------------------------------

export const AiProviderSchema = z.enum(["openai_api", "codex_cli"]);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const CreateRunRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  conversationId: z.string().optional(),
  inputMode: z.enum(["text", "voice"]).default("text"),
  /** One-off provider override (e.g. retrying with the API after a Codex failure). Audited. */
  provider: AiProviderSchema.optional(),
});
export type CreateRunRequest = z.input<typeof CreateRunRequestSchema>;

export const CreateRunResponseSchema = z.object({ runId: z.string(), conversationId: z.string() });
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const RunStepStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "denied", "awaiting_approval"]);
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>;

export const RunStepSchema = z.object({
  id: z.string(),
  toolId: z.string(),
  label: z.string(),
  status: RunStepStatusSchema,
  startedAt: IsoDate,
  finishedAt: IsoDate.nullable(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunViewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  status: RunStatusSchema,
  request: z.string(),
  finalMessage: z.string().nullable(),
  error: ErrorDtoSchema.nullable(),
  approvalId: z.string().nullable(),
  skills: z.array(z.string()),
  steps: z.array(RunStepSchema),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type RunView = z.infer<typeof RunViewSchema>;

export const HistoryOutcomeSchema = z.enum(["answered", "action_taken", "cancelled", "failed", "pending"]);
export type HistoryOutcome = z.infer<typeof HistoryOutcomeSchema>;

export const HistoryItemSchema = z.object({
  runId: z.string(),
  request: z.string(),
  status: RunStatusSchema,
  summary: z.string().nullable(),
  outcome: HistoryOutcomeSchema,
  createdAt: IsoDate,
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const ApprovalFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  editable: z.boolean(),
  kind: z.enum(["text", "longtext", "recipients"]),
});
export type ApprovalField = z.infer<typeof ApprovalFieldSchema>;

export const ApprovalViewSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  account: z.string().nullable(),
  fields: z.array(ApprovalFieldSchema),
  risk: RiskLevelSchema,
  status: ApprovalStatusSchema,
  /** Hash of the immutable proposed action. Must be echoed back when resolving. */
  actionHash: z.string(),
  warnings: z.array(z.string()),
  createdAt: IsoDate,
  expiresAt: IsoDate.nullable(),
  error: ErrorDtoSchema.nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const ResolveApprovalRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  actionHash: z.string().min(16),
  /** Values for editable fields only. Any other key is rejected. */
  edits: z.record(z.string(), z.string().max(20000)).optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const AccountProviderSchema = z.enum(["google", "instagram", "mcp"]);
export type AccountProvider = z.infer<typeof AccountProviderSchema>;
export const AccountStatusSchema = z.enum(["connected", "needs_reauth", "error", "disconnected", "pending"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  provider: AccountProviderSchema,
  displayName: z.string(),
  address: z.string().nullable(),
  status: AccountStatusSchema,
  capabilities: z.array(z.string()),
  lastCheckedAt: IsoDate.nullable(),
  lastError: z.string().nullable(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const ConnectAccountResponseSchema = z.object({ authUrl: z.string() });
export type ConnectAccountResponse = z.infer<typeof ConnectAccountResponseSchema>;

// ---------------------------------------------------------------------------
// Skills, memory, workflows, proposals
// ---------------------------------------------------------------------------

export const SkillOriginSchema = z.enum(["builtin", "agent", "user"]);

export const SkillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int(),
  risk: RiskLevelSchema,
  enabled: z.boolean(),
  origin: SkillOriginSchema,
  tools: z.array(z.string()),
  updatedAt: IsoDate,
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillVersionStatusSchema = z.enum(["proposed", "validated", "active", "deprecated", "rolled_back", "rejected"]);
export type SkillVersionStatus = z.infer<typeof SkillVersionStatusSchema>;

export const SkillVersionViewSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: SkillVersionStatusSchema,
  createdBy: z.string(),
  reason: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  issues: z.array(z.string()),
  createdAt: IsoDate,
});
export type SkillVersionView = z.infer<typeof SkillVersionViewSchema>;

export const SkillDetailSchema = SkillSummarySchema.extend({
  content: z.string(),
  versions: z.array(SkillVersionViewSchema),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const MEMORY_TYPES = [
  "preference",
  "identity",
  "account_mapping",
  "contact",
  "project",
  "routine",
  "notification_rule",
  "environment",
] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryViewSchema = z.object({
  id: z.string(),
  type: MemoryTypeSchema,
  content: z.string(),
  source: z.enum(["user", "agent-inferred"]),
  confidence: z.number(),
  status: z.enum(["active", "proposed"]),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  expiresAt: IsoDate.nullable(),
});
export type MemoryView = z.infer<typeof MemoryViewSchema>;

export const CreateMemoryRequestSchema = z.object({
  type: MemoryTypeSchema,
  content: z.string().trim().min(1).max(2000),
  expiresAt: IsoDate.optional(),
});
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequestSchema>;

export const UpdateMemoryRequestSchema = z.object({
  content: z.string().trim().min(1).max(2000).optional(),
  type: MemoryTypeSchema.optional(),
  status: z.literal("active").optional(),
});
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequestSchema>;

export const ProposalKindSchema = z.enum(["MEMORY_PROPOSAL", "SKILL_PROPOSAL", "SKILL_PATCH", "WORKFLOW_PROPOSAL"]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const ProposalViewSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  kind: ProposalKindSchema,
  title: z.string(),
  summary: z.string(),
  status: z.enum(["pending", "accepted", "rejected", "auto_applied"]),
  createdAt: IsoDate,
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

export const WorkflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int(),
  enabled: z.boolean(),
  origin: SkillOriginSchema,
  steps: z.number().int(),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

// ---------------------------------------------------------------------------
// Notifications / attention feed
// ---------------------------------------------------------------------------

export const NotificationActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["reply", "open", "dismiss"]),
  /** For `reply`: a command pre-filled into the assistant. For `open`: a URL. */
  value: z.string().optional(),
});
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

export const NotificationViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  source: z.string(),
  category: z.string().nullable(),
  importance: z.number(),
  status: z.enum(["unread", "read", "dismissed"]),
  actions: z.array(NotificationActionSchema),
  createdAt: IsoDate,
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

// ---------------------------------------------------------------------------
// Audit, settings, identity
// ---------------------------------------------------------------------------

export const AuditEntrySchema = z.object({
  id: z.string(),
  actorType: z.enum(["user", "device", "agent", "system"]),
  actorId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  runId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: IsoDate,
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** Emergency controls from SECURITY.md §12. Available without involving the agent. */
export const SettingsViewSchema = z.object({
  writeToolsDisabled: z.boolean(),
  deviceControlDisabled: z.boolean(),
  monitoringDisabled: z.boolean(),
  agentPaused: z.boolean(),
  autoActivateLowRiskSkills: z.boolean(),
  /** Model backend for the assistant. */
  aiProvider: AiProviderSchema,
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;
export const UpdateSettingsRequestSchema = SettingsViewSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

export const MeResponseSchema = z.object({
  userId: z.string(),
  name: z.string(),
  deviceId: z.string(),
  serverVersion: z.string(),
  model: z.string(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const TranscriptionResponseSchema = z.object({ text: z.string() });
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;

// ---------------------------------------------------------------------------
// Model providers
// ---------------------------------------------------------------------------

export const ProviderStatusSchema = z.object({
  id: AiProviderSchema,
  label: z.string(),
  active: z.boolean(),
  /** ready | not_configured | not_installed | not_signed_in | starting | crashed | error | stopped */
  state: z.string(),
  /** Short user-facing status, e.g. "Connected", "Not signed in". */
  summary: z.string(),
  /** Actionable hint, e.g. "Run: codex login". */
  hint: z.string().nullable(),
  details: z.record(z.string(), z.string()),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
