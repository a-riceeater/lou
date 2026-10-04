import { sql } from "drizzle-orm";
import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema. Timestamps are ISO-8601 strings. Secrets (OAuth tokens, device
 * command keys) are stored only as AES-256-GCM ciphertext (`*_enc` columns);
 * device bearer tokens are stored only as SHA-256 hashes.
 */

const id = () => text("id").primaryKey();
const createdAt = () => text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const updatedAt = () => text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const users = sqliteTable("users", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: createdAt(),
});

export const devices = sqliteTable(
  "devices",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    credentialHash: text("credential_hash").notNull(),
    commandKeyEnc: text("command_key_enc").notNull(),
    capabilities: json<string[]>("capabilities").notNull().default([]),
    clientVersion: text("client_version"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("devices_credential_hash_idx").on(t.credentialHash), index("devices_user_idx").on(t.userId)],
);

export const deviceSessions = sqliteTable(
  "device_sessions",
  {
    id: id(),
    deviceId: text("device_id").notNull().references(() => devices.id),
    remoteAddr: text("remote_addr"),
    connectedAt: createdAt(),
    lastHeartbeatAt: text("last_heartbeat_at"),
    disconnectedAt: text("disconnected_at"),
    closeReason: text("close_reason"),
  },
  (t) => [index("device_sessions_device_idx").on(t.deviceId)],
);

export const pairingCodes = sqliteTable("pairing_codes", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  usedByDeviceId: text("used_by_device_id"),
  createdAt: createdAt(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    /** Email address, Instagram handle, or MCP server name. */
    address: text("address"),
    externalId: text("external_id"),
    capabilities: json<string[]>("capabilities").notNull().default([]),
    status: text("status").notNull().default("pending"),
    lastCheckedAt: text("last_checked_at"),
    lastError: text("last_error"),
    /** Provider-specific non-secret state (e.g. Gmail historyId). */
    metadata: json<Record<string, unknown>>("metadata").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("accounts_provider_external_idx").on(t.userId, t.provider, t.externalId)],
);

export const oauthConnections = sqliteTable("oauth_connections", {
  id: id(),
  accountId: text("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  scopes: json<string[]>("scopes").notNull().default([]),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: text("expires_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const oauthStates = sqliteTable("oauth_states", {
  id: id(),
  /** SHA-256 of the opaque state parameter. */
  stateHash: text("state_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  codeVerifierEnc: text("code_verifier_enc"),
  expiresAt: text("expires_at").notNull(),
  createdAt: createdAt(),
});

export const conversations = sqliteTable("conversations", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id),
  title: text("title"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    runId: text("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: id(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    deviceId: text("device_id"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    request: text("request").notNull(),
    model: text("model").notNull(),
    /** Model-visible state only (transcript, exposed tools, queue). No hidden reasoning. */
    state: json<Record<string, unknown>>("state").notNull(),
    selectedSkills: json<string[]>("selected_skills").notNull().default([]),
    finalMessage: text("final_message"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    pendingApprovalId: text("pending_approval_id"),
    actionsTaken: integer("actions_taken").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: text("completed_at"),
  },
  (t) => [index("agent_runs_user_created_idx").on(t.userId, t.createdAt), index("agent_runs_status_idx").on(t.status)],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: id(),
    runId: text("run_id"),
    toolId: text("tool_id").notNull(),
    input: json<unknown>("input"),
    output: json<unknown>("output"),
    status: text("status").notNull(),
    risk: text("risk").notNull(),
    executionTarget: text("execution_target").notNull(),
    deviceId: text("device_id"),
    approvalId: text("approval_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: createdAt(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("tool_calls_run_idx").on(t.runId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: id(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    workflowRunId: text("workflow_run_id"),
    toolCallId: text("tool_call_id"),
    toolId: text("tool_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    account: text("account"),
    /** Display fields (keys map to proposed input keys). */
    fields: json<Array<{ key: string; label: string; value: string; kind: string }>>("fields").notNull(),
    /** Immutable proposed action input. */
    proposedInput: json<Record<string, unknown>>("proposed_input").notNull(),
    actionHash: text("action_hash").notNull(),
    editableFields: json<string[]>("editable_fields").notNull().default([]),
    risk: text("risk").notNull(),
    reasons: json<string[]>("reasons").notNull().default([]),
    tainted: integer("tainted", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("pending"),
    finalInput: json<Record<string, unknown>>("final_input"),
    finalHash: text("final_hash"),
    edited: integer("edited", { mode: "boolean" }).notNull().default(false),
    resolvedByDeviceId: text("resolved_by_device_id"),
    resolvedAt: text("resolved_at"),
    executedAt: text("executed_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    expiresAt: text("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_user_status_idx").on(t.userId, t.status)],
);

export const events = sqliteTable(
  "events",
  {
    id: id(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    accountId: text("account_id"),
    type: text("type").notNull(),
    externalId: text("external_id"),
    trust: text("trust").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    status: text("status").notNull().default("received"),
    decision: text("decision"),
    classification: json<Record<string, unknown>>("classification"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: createdAt(),
    processedAt: text("processed_at"),
  },
  (t) => [uniqueIndex("events_dedupe_idx").on(t.source, t.externalId), index("events_user_created_idx").on(t.userId, t.createdAt)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id").notNull(),
    eventId: text("event_id"),
    source: text("source").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category"),
    importance: real("importance").notNull().default(0.5),
    actions: json<Array<{ id: string; label: string; kind: string; value?: string }>>("actions").notNull().default([]),
    status: text("status").notNull().default("unread"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: id(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull(),
    confidence: real("confidence").notNull(),
    status: text("status").notNull().default("active"),
    /** Float32 embedding vector, if an embedding provider is configured. */
    embedding: blob("embedding", { mode: "buffer" }),
    embeddingModel: text("embedding_model"),
    sourceRunId: text("source_run_id"),
    expiresAt: text("expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memories_user_status_idx").on(t.userId, t.status)],
);

export const skills = sqliteTable("skills", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("general"),
  origin: text("origin").notNull(),
  risk: text("risk").notNull(),
  tools: json<string[]>("tools").notNull().default([]),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Version number currently active (null when none is active yet). */
  activeVersion: integer("active_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const skillVersions = sqliteTable(
  "skill_versions",
  {
    id: id(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    sourceRunId: text("source_run_id"),
    reason: text("reason"),
    issues: json<string[]>("issues").notNull().default([]),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("skill_versions_skill_version_idx").on(t.skillId, t.version)],
);

export const workflows = sqliteTable("workflows", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  origin: text("origin").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  activeVersion: integer("active_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    id: id(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    version: integer("version").notNull(),
    definition: json<Record<string, unknown>>("definition").notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    sourceRunId: text("source_run_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workflow_versions_wf_version_idx").on(t.workflowId, t.version)],
);

export const workflowRuns = sqliteTable("workflow_runs", {
  id: id(),
  userId: text("user_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  version: integer("version").notNull(),
  agentRunId: text("agent_run_id"),
  status: text("status").notNull(),
  stepIndex: integer("step_index").notNull().default(0),
  state: json<Record<string, unknown>>("state").notNull(),
  pendingApprovalId: text("pending_approval_id"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const proposals = sqliteTable("proposals", {
  id: id(),
  userId: text("user_id").notNull(),
  runId: text("run_id"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  /** ID of the created object (memory, skill version, workflow version). */
  targetId: text("target_id"),
  status: text("status").notNull().default("pending"),
  createdAt: createdAt(),
  resolvedAt: text("resolved_at"),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    userId: text("user_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    runId: text("run_id"),
    details: json<Record<string, unknown>>("details").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt), index("audit_log_run_idx").on(t.runId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: updatedAt(),
});
