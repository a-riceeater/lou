import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  REPLAYABLE_TYPES,
  type ClientMessage,
  type DeviceCommandBody,
  type ServerMessage,
  type ServerMessageType,
  type ServerPayload,
} from "@lou/protocol";
import { LouError, newId, type SerializedError } from "@lou/shared";
import type { TargetDevice } from "@lou/tools";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type { AuditLog } from "../core/audit";
import type { EventBus } from "../core/bus";
import type { Db } from "../db/client";
import { deviceSessions } from "../db/schema";
import type { Logger } from "../logger";
import { hmacBase64 } from "../security/crypto";
import type { AuthenticatedDevice, DeviceRegistry } from "./registry";

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const COMMAND_TTL_MS = 60_000;
const REPLAY_BUFFER = 300;

interface Session {
  id: string;
  device: AuthenticatedDevice;
  socket: WebSocket;
  capabilities: string[];
  alive: boolean;
}

interface PendingCommand {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (err: LouError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Live device connections: the WebSocket session lifecycle, server → device push
 * with replay on reconnect, and signed device commands (DESKTOP_CLIENT.md §6).
 */
export class DeviceGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingCommand>();
  /** Per-user replay buffers. Seq starts from boot time so it increases across restarts. */
  private readonly buffers = new Map<string, Array<{ seq: number; frame: string }>>();
  private seq = Date.now() * 1000;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly registry: DeviceRegistry,
    private readonly audit: AuditLog,
    bus: EventBus,
    private readonly logger: Logger,
  ) {
    bus.on("run.progress", (e) => this.broadcast(e.userId, "agent.progress", { runId: e.runId, status: e.status, label: e.label }, e.runId));
    bus.on("run.delta", (e) => this.broadcast(e.userId, "agent.delta", { runId: e.runId, text: e.text }, e.runId));
    bus.on("run.completed", (e) =>
      this.broadcast(e.userId, "agent.completed", { runId: e.runId, status: e.status, message: e.message, error: e.error }, e.runId),
    );
    bus.on("approval.requested", (e) => this.broadcast(e.userId, "approval.requested", { approval: e.approval }, e.approval.runId ?? undefined));
    bus.on("approval.resolved", (e) =>
      this.broadcast(e.userId, "approval.resolved", { approvalId: e.approvalId, status: e.status, runId: e.runId }, e.runId ?? undefined),
    );
    bus.on("notification.created", (e) => this.broadcast(e.userId, "notification.created", { notification: e.notification }));
    bus.on("device.revoked", (e) => this.disconnect(e.deviceId, "revoked"));

    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  isOnline(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  /** Called by the WebSocket route after the bearer credential was verified. */
  accept(socket: WebSocket, device: AuthenticatedDevice, remoteAddr: string | undefined): void {
    const sessionId = newId("ses");
    let session: Session | undefined;
    this.db.insert(deviceSessions).values({ id: sessionId, deviceId: device.deviceId, remoteAddr: remoteAddr ?? null }).run();

    const helloTimer = setTimeout(() => {
      if (!session) socket.close(4002, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessageSchema.parse(JSON.parse(data.toString()));
      } catch {
        this.send(socket, "error", { code: "VALIDATION_FAILED", message: "Invalid frame." });
        return;
      }
      if (!session) {
        if (msg.type !== "device.hello") {
          socket.close(4003, "expected hello");
          return;
        }
        clearTimeout(helloTimer);
        session = this.onHello(socket, device, sessionId, msg);
        return;
      }
      this.onMessage(session, msg);
    });

    socket.on("pong", () => {
      if (session) session.alive = true;
    });

    socket.on("close", (code, reason) => {
      clearTimeout(helloTimer);
      if (session && this.sessions.get(device.deviceId) === session) {
        this.sessions.delete(device.deviceId);
        this.failPending(device.deviceId);
      }
      // During shutdown sessions are closed in bulk before the database closes.
      if (this.closing) return;
      this.db
        .update(deviceSessions)
        .set({ disconnectedAt: new Date().toISOString(), closeReason: `${code} ${reason.toString()}`.trim() })
        .where(eq(deviceSessions.id, sessionId))
        .run();
      this.logger.info({ deviceId: device.deviceId, code }, "device disconnected");
    });
    socket.on("error", (err) => this.logger.warn({ err, deviceId: device.deviceId }, "device socket error"));
  }

  private onHello(socket: WebSocket, device: AuthenticatedDevice, sessionId: string, msg: Extract<ClientMessage, { type: "device.hello" }>): Session {
    const previous = this.sessions.get(device.deviceId);
    if (previous) previous.socket.close(4004, "replaced by new session");

    const session: Session = { id: sessionId, device, socket, capabilities: msg.payload.capabilities, alive: true };
    this.sessions.set(device.deviceId, session);
    this.registry.updateCapabilities(device.deviceId, msg.payload.capabilities, msg.payload.clientVersion);

    const buffer = this.buffers.get(device.userId) ?? [];
    const lastSeq = msg.payload.lastSeq;
    const oldest = buffer[0]?.seq;
    const resyncRequired = lastSeq === undefined || oldest === undefined || lastSeq < oldest - 1 || lastSeq > this.seq;

    this.send(socket, "session.ready", {
      sessionId,
      deviceId: device.deviceId,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
      currentSeq: this.seq,
      resyncRequired,
    });
    if (lastSeq !== undefined) for (const item of buffer) if (item.seq > lastSeq) socket.send(item.frame);

    this.audit.record({
      userId: device.userId,
      actorType: "device",
      actorId: device.deviceId,
      action: "device.connected",
      targetType: "device",
      targetId: device.deviceId,
      details: { capabilities: msg.payload.capabilities, clientVersion: msg.payload.clientVersion },
    });
    this.logger.info({ deviceId: device.deviceId, resyncRequired }, "device connected");
    return session;
  }

  private onMessage(session: Session, msg: ClientMessage): void {
    switch (msg.type) {
      case "device.heartbeat":
        session.alive = true;
        this.registry.touch(session.device.deviceId);
        this.db.update(deviceSessions).set({ lastHeartbeatAt: new Date().toISOString() }).where(eq(deviceSessions.id, session.id)).run();
        break;
      case "ping":
        this.send(session.socket, "pong", {}, undefined, msg.id);
        break;
      case "device.command.result": {
        const pending = this.pending.get(msg.payload.commandId);
        if (!pending || pending.deviceId !== session.device.deviceId) return;
        this.pending.delete(msg.payload.commandId);
        clearTimeout(pending.timer);
        if (msg.payload.success) pending.resolve(msg.payload.result ?? {});
        else {
          const e = msg.payload.error;
          pending.reject(new LouError((e?.code as SerializedError["code"]) ?? "UPSTREAM_ERROR", e?.message ?? "The device could not complete the action."));
        }
        break;
      }
      case "device.hello":
        break;
    }
  }

  /** Sends a signed command and waits for the device's result. */
  async sendCommand(deviceId: string, toolId: string, input: Record<string, unknown>, approvalId: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.sessions.get(deviceId);
    if (!session) throw new LouError("DEVICE_OFFLINE", "That device is offline.");

    const commandId = newId("cmd");
    const issuedAt = new Date();
    const body: DeviceCommandBody = {
      commandId,
      deviceId,
      toolId,
      input,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + COMMAND_TTL_MS).toISOString(),
      approvalId: approvalId ?? null,
    };
    const bodyJson = JSON.stringify(body);
    const signature = hmacBase64(this.registry.commandKey(deviceId), bodyJson);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new LouError("TIMEOUT", "The device did not respond in time."));
      }, COMMAND_TTL_MS);
      this.pending.set(commandId, { deviceId, resolve, reject, timer });
      signal.addEventListener(
        "abort",
        () => {
          if (this.pending.delete(commandId)) {
            clearTimeout(timer);
            reject(new LouError("CANCELLED", "Cancelled."));
          }
        },
        { once: true },
      );
      this.send(session.socket, "device.command", { commandId, body: bodyJson, signature });
    });
  }

  /** Chooses the device a device tool should target. */
  resolveTarget(userId: string, requested: string | undefined, origin: string | undefined, known: (id: string) => { userId: string; status: string; capabilities: string[] } | undefined): TargetDevice | undefined {
    const pick = (id: string | undefined): TargetDevice | undefined => {
      if (!id) return undefined;
      const row = known(id);
      if (!row || row.userId !== userId || row.status !== "active") return undefined;
      const live = this.sessions.get(id);
      return { id, online: !!live, capabilities: live?.capabilities ?? row.capabilities };
    };
    if (requested) return pick(requested);
    const fromOrigin = pick(origin);
    if (fromOrigin?.online) return fromOrigin;
    // Fall back to any online desktop device of this user.
    for (const s of this.sessions.values()) {
      if (s.device.userId === userId && s.device.platform !== "ios") return pick(s.device.deviceId);
    }
    return fromOrigin;
  }

  broadcast<T extends ServerMessageType>(userId: string, type: T, payload: ServerPayload<T>, runId?: string): void {
    const replayable = REPLAYABLE_TYPES.has(type);
    const seq = replayable ? ++this.seq : undefined;
    const frame = JSON.stringify({ v: 1, id: newId("msg"), type, ts: new Date().toISOString(), payload, ...(seq ? { seq } : {}), ...(runId ? { runId } : {}) } as ServerMessage);
    if (seq) {
      const buffer = this.buffers.get(userId) ?? [];
      buffer.push({ seq, frame });
      if (buffer.length > REPLAY_BUFFER) buffer.splice(0, buffer.length - REPLAY_BUFFER);
      this.buffers.set(userId, buffer);
    }
    for (const session of this.sessions.values()) {
      if (session.device.userId === userId && session.socket.readyState === session.socket.OPEN) session.socket.send(frame);
    }
  }

  disconnect(deviceId: string, reason: string): void {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    if (reason === "revoked") this.send(session.socket, "device.revoked", {});
    session.socket.close(4001, reason);
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.closing = true;
    for (const session of this.sessions.values()) {
      this.db.update(deviceSessions).set({ disconnectedAt: new Date().toISOString(), closeReason: "server shutdown" }).where(eq(deviceSessions.id, session.id)).run();
    }
    for (const session of this.sessions.values()) session.socket.close(1001, "server shutting down");
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LouError("CANCELLED", "Server shutting down."));
      this.pending.delete(id);
    }
  }

  private heartbeat(): void {
    for (const session of this.sessions.values()) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }

  private failPending(deviceId: string): void {
    for (const [id, p] of this.pending) {
      if (p.deviceId !== deviceId) continue;
      clearTimeout(p.timer);
      p.reject(new LouError("DEVICE_OFFLINE", "The device disconnected."));
      this.pending.delete(id);
    }
  }

  private send<T extends ServerMessageType>(socket: WebSocket, type: T, payload: ServerPayload<T>, runId?: string, replyTo?: string): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ v: 1, id: newId("msg"), type, ts: new Date().toISOString(), payload, ...(runId ? { runId } : {}), ...(replyTo ? { replyTo } : {}) }));
  }
}
