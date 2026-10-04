import type { DeviceRegisterRequest, DeviceRegisterResponse, DeviceView } from "@lou/protocol";
import { LouError, newId, newPairingCode } from "@lou/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AuditLog } from "../core/audit";
import type { EventBus } from "../core/bus";
import type { Db } from "../db/client";
import { devices, pairingCodes } from "../db/schema";
import { randomToken, sha256Hex, type Vault } from "../security/crypto";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 30_000;

export interface AuthenticatedDevice {
  deviceId: string;
  userId: string;
  name: string;
  platform: string;
  capabilities: string[];
}

/**
 * Device identity: pairing, registration, credential verification and revocation
 * (SECURITY.md §6). Bearer tokens are stored as SHA-256 hashes only; per-device
 * command-signing keys are stored encrypted.
 */
export class DeviceRegistry {
  private readonly lastSeenWrites = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  createPairingCode(userId: string, actor: { type: "user" | "device" | "system"; id?: string }): { code: string; expiresAt: string } {
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    this.db.insert(pairingCodes).values({ id: newId("pair"), userId, codeHash: sha256Hex(normalizeCode(code)), expiresAt }).run();
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "device.pairing_code_created", details: { expiresAt } });
    return { code, expiresAt };
  }

  register(req: DeviceRegisterRequest, remoteAddr?: string): DeviceRegisterResponse {
    const codeHash = sha256Hex(normalizeCode(req.pairingCode));
    return this.db.transaction((tx) => {
      const pairing = tx.select().from(pairingCodes).where(eq(pairingCodes.codeHash, codeHash)).get();
      if (!pairing || pairing.usedAt || pairing.expiresAt < new Date().toISOString()) {
        this.audit.record({ actorType: "system", action: "device.registration_failed", details: { reason: "invalid_pairing_code", remoteAddr } });
        throw new LouError("UNAUTHORIZED", "That pairing code is invalid or has expired.");
      }
      const deviceId = newId("dev");
      const token = `lou_dev_${randomToken(32)}`;
      const commandKey = randomBytes(32).toString("base64");
      tx.insert(devices)
        .values({
          id: deviceId,
          userId: pairing.userId,
          name: req.name,
          platform: req.platform,
          credentialHash: sha256Hex(token),
          commandKeyEnc: this.vault.encrypt(commandKey),
          capabilities: req.capabilities,
          clientVersion: req.clientVersion ?? null,
          lastSeenAt: new Date().toISOString(),
        })
        .run();
      tx.update(pairingCodes)
        .set({ usedAt: new Date().toISOString(), usedByDeviceId: deviceId })
        .where(and(eq(pairingCodes.id, pairing.id), isNull(pairingCodes.usedAt)))
        .run();
      this.audit.record({
        userId: pairing.userId,
        actorType: "device",
        actorId: deviceId,
        action: "device.registered",
        targetType: "device",
        targetId: deviceId,
        details: { name: req.name, platform: req.platform, capabilities: req.capabilities, remoteAddr },
      });
      return { deviceId, deviceToken: token, commandKey, userId: pairing.userId };
    });
  }

  /** Verifies a bearer credential. Returns undefined for unknown or revoked devices. */
  authenticate(token: string | undefined): AuthenticatedDevice | undefined {
    if (!token || !token.startsWith("lou_dev_")) return undefined;
    const row = this.db.select().from(devices).where(eq(devices.credentialHash, sha256Hex(token))).get();
    if (!row || row.status !== "active") return undefined;
    this.touch(row.id);
    return { deviceId: row.id, userId: row.userId, name: row.name, platform: row.platform, capabilities: row.capabilities };
  }

  touch(deviceId: string): void {
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(deviceId) ?? 0) < LAST_SEEN_THROTTLE_MS) return;
    this.lastSeenWrites.set(deviceId, now);
    this.db.update(devices).set({ lastSeenAt: new Date(now).toISOString() }).where(eq(devices.id, deviceId)).run();
  }

  updateCapabilities(deviceId: string, capabilities: string[], clientVersion: string): void {
    this.db.update(devices).set({ capabilities, clientVersion, lastSeenAt: new Date().toISOString() }).where(eq(devices.id, deviceId)).run();
  }

  commandKey(deviceId: string): Buffer {
    const row = this.db.select({ enc: devices.commandKeyEnc }).from(devices).where(eq(devices.id, deviceId)).get();
    if (!row) throw new LouError("NOT_FOUND", "Unknown device.");
    return Buffer.from(this.vault.decrypt(row.enc), "base64");
  }

  get(deviceId: string) {
    return this.db.select().from(devices).where(eq(devices.id, deviceId)).get();
  }

  list(userId: string, online: (deviceId: string) => boolean, currentDeviceId?: string): DeviceView[] {
    return this.db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.lastSeenAt))
      .all()
      .map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform as DeviceView["platform"],
        status: d.status as DeviceView["status"],
        online: d.status === "active" && online(d.id),
        capabilities: d.capabilities,
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
        current: d.id === currentDeviceId,
      }));
  }

  revoke(userId: string, deviceId: string, actor: { type: "user" | "device" | "system"; id?: string }): void {
    const result = this.db
      .update(devices)
      .set({ status: "revoked", revokedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), eq(devices.status, "active")))
      .run();
    if (result.changes === 0) throw new LouError("NOT_FOUND", "Device not found or already revoked.");
    this.audit.record({ userId, actorType: actor.type, actorId: actor.id, action: "device.revoked", targetType: "device", targetId: deviceId });
    this.bus.emit("device.revoked", { userId, deviceId });
  }
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}
