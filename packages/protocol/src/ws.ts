import { z } from "zod";
import { ApprovalViewSchema, NotificationViewSchema } from "./api";
import { ErrorDtoSchema, RunStatusSchema } from "./common";

/**
 * WebSocket protocol between the server and device agents.
 *
 * Every frame is an envelope `{ v, id, type, ts, payload, ... }`. Server → client
 * frames that matter for UI state carry a monotonically increasing `seq` so a
 * reconnecting client can ask the server to replay anything it missed.
 *
 * The C# client mirrors these shapes in `Lou.Agent/Protocol/Messages.cs`.
 */

const envelopeBase = {
  v: z.literal(1),
  /** Unique message/request ID. Responses reference it via `replyTo`. */
  id: z.string().min(1).max(64),
  ts: z.string(),
  seq: z.number().int().nonnegative().optional(),
  deviceId: z.string().optional(),
  runId: z.string().optional(),
  replyTo: z.string().optional(),
};

function frame<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({ ...envelopeBase, type: z.literal(type), payload });
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export const DeviceHelloSchema = frame(
  "device.hello",
  z.object({
    platform: z.enum(["windows", "macos", "ios", "web"]),
    clientVersion: z.string().max(40),
    capabilities: z.array(z.string().max(64)).max(64),
    /** Last `seq` the client processed; the server replays newer frames. */
    lastSeq: z.number().int().nonnegative().optional(),
  }),
);

export const DeviceHeartbeatSchema = frame("device.heartbeat", z.object({}).passthrough());

export const DeviceCommandResultSchema = frame(
  "device.command.result",
  z.object({
    commandId: z.string(),
    success: z.boolean(),
    result: z.unknown().optional(),
    error: ErrorDtoSchema.optional(),
  }),
);

export const ClientPingSchema = frame("ping", z.object({}).passthrough());

export const ClientMessageSchema = z.discriminatedUnion("type", [
  DeviceHelloSchema,
  DeviceHeartbeatSchema,
  DeviceCommandResultSchema,
  ClientPingSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const SessionReadySchema = frame(
  "session.ready",
  z.object({
    sessionId: z.string(),
    deviceId: z.string(),
    protocolVersion: z.number().int(),
    serverTime: z.string(),
    /** Highest seq the server has issued for this user. */
    currentSeq: z.number().int().nonnegative(),
    /** True if the replay buffer could not cover the gap; client should refetch state over HTTPS. */
    resyncRequired: z.boolean(),
  }),
);

export const AgentProgressSchema = frame(
  "agent.progress",
  z.object({
    runId: z.string(),
    status: RunStatusSchema,
    /** Friendly, user-facing label such as "Searching email". Never a raw tool name. */
    label: z.string().optional(),
    stepId: z.string().optional(),
  }),
);

export const AgentCompletedSchema = frame(
  "agent.completed",
  z.object({
    runId: z.string(),
    status: RunStatusSchema,
    message: z.string().nullable(),
    error: ErrorDtoSchema.nullable(),
  }),
);

export const ApprovalRequestedSchema = frame("approval.requested", z.object({ approval: ApprovalViewSchema }));

export const ApprovalResolvedSchema = frame(
  "approval.resolved",
  z.object({ approvalId: z.string(), status: z.string(), runId: z.string().nullable() }),
);

export const NotificationCreatedSchema = frame("notification.created", z.object({ notification: NotificationViewSchema }));

/**
 * A signed instruction for the device agent. `body` is a JSON string of
 * {@link DeviceCommandBody}; `signature` is base64 HMAC-SHA256 over the exact
 * UTF-8 bytes of `body` using the per-device command key. Signing the transmitted
 * string (rather than re-serialized JSON) avoids cross-language canonicalization bugs.
 */
export const DeviceCommandSchema = frame(
  "device.command",
  z.object({
    commandId: z.string(),
    body: z.string(),
    signature: z.string(),
  }),
);

export const DeviceCommandBodySchema = z.object({
  commandId: z.string(),
  deviceId: z.string(),
  toolId: z.string(),
  input: z.record(z.string(), z.unknown()),
  issuedAt: z.string(),
  expiresAt: z.string(),
  /** Present when the server already obtained user approval for this exact command. */
  approvalId: z.string().nullable(),
});
export type DeviceCommandBody = z.infer<typeof DeviceCommandBodySchema>;

export const DeviceRevokedSchema = frame("device.revoked", z.object({}).passthrough());
export const ServerErrorSchema = frame("error", ErrorDtoSchema);
export const ServerPongSchema = frame("pong", z.object({}).passthrough());

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SessionReadySchema,
  AgentProgressSchema,
  AgentCompletedSchema,
  ApprovalRequestedSchema,
  ApprovalResolvedSchema,
  NotificationCreatedSchema,
  DeviceCommandSchema,
  DeviceRevokedSchema,
  ServerErrorSchema,
  ServerPongSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
export type ServerPayload<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>["payload"];
export type ClientPayload<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>["payload"];

/** Server frames that are buffered for replay on reconnect. */
export const REPLAYABLE_TYPES: ReadonlySet<ServerMessageType> = new Set([
  "agent.progress",
  "agent.completed",
  "approval.requested",
  "approval.resolved",
  "notification.created",
]);
