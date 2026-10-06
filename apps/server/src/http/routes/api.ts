import {
  ApprovalStatusSchema,
  CreateMemoryRequestSchema,
  CreateRunRequestSchema,
  GoogleAppCredentialsRequestSchema,
  MemoryTypeSchema,
  ResolveApprovalRequestSchema,
  SpotifyAppCredentialsRequestSchema,
  SpotifyPlayerActionRequestSchema,
  UpdateMemoryRequestSchema,
  UpdateSettingsRequestSchema,
  type MeResponse,
} from "@lou/protocol";
import { LouError } from "@lou/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../../container";
import { authenticate, requireDevice } from "../auth";

const IdParam = z.object({ id: z.string().min(1).max(64) });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().optional() });

/** Authenticated device API (HTTPS). Every route requires a valid, unrevoked device credential. */
export async function apiRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.addHook("preHandler", authenticate(s.devices));

  // ---- Identity -----------------------------------------------------------
  app.get("/api/me", async (request): Promise<MeResponse> => {
    const d = requireDevice(request);
    const user = s.users.get(d.userId);
    return { userId: d.userId, name: user?.name ?? "", deviceId: d.deviceId, serverVersion: s.config.version, model: s.providers.modelLabel() };
  });

  // ---- Runs & history -------------------------------------------------------
  app.post("/api/runs", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const d = requireDevice(request);
    const body = CreateRunRequestSchema.parse(request.body);
    return reply.status(202).send(s.agent.start(d.userId, d.deviceId, body));
  });

  app.get("/api/runs/:id", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const view = s.runs.view(d.userId, id);
    if (!view) throw new LouError("NOT_FOUND", "Run not found.");
    return view;
  });

  app.post("/api/runs/:id/cancel", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    if (!s.runs.view(d.userId, id)) throw new LouError("NOT_FOUND", "Run not found.");
    await s.agent.cancel(d.userId, id, d.deviceId);
    return { ok: true };
  });

  app.get("/api/history", async (request) => {
    const d = requireDevice(request);
    const q = ListQuery.parse(request.query);
    return { items: s.runs.history(d.userId, q) };
  });

  // ---- Approvals --------------------------------------------------------------
  app.get("/api/approvals", async (request) => {
    const d = requireDevice(request);
    const q = z.object({ status: ApprovalStatusSchema.optional() }).parse(request.query);
    return { items: s.approvals.list(d.userId, q.status) };
  });

  app.get("/api/approvals/:id", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const view = s.approvals.view(d.userId, id);
    if (!view) throw new LouError("NOT_FOUND", "Approval not found.");
    return view;
  });

  app.post("/api/approvals/:id/resolve", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const body = ResolveApprovalRequestSchema.parse(request.body);
    return s.approvals.resolve(d.userId, id, body, { deviceId: d.deviceId });
  });

  // ---- Accounts ----------------------------------------------------------------
  app.get("/api/accounts", async (request) => {
    const d = requireDevice(request);
    return { items: s.integrations.list(d.userId), available: { google: s.google.configured, instagram: s.instagram.configured, spotify: s.spotify.configured } };
  });

  app.post("/api/accounts/google/connect", async (request) => {
    const d = requireDevice(request);
    s.audit.record({ userId: d.userId, actorType: "device", actorId: d.deviceId, action: "account.connect_started", details: { provider: "google" } });
    return s.google.startConnect(d.userId);
  });

  // ---- Gmail setup (the Google OAuth client, entered from the setup dialog) -------
  app.get("/api/google", async (request) => (requireDevice(request), s.google.status()));

  app.post("/api/google/app", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const d = requireDevice(request);
    await s.google.saveAppCredentials(d.userId, GoogleAppCredentialsRequestSchema.parse(request.body), { type: "device", id: d.deviceId });
    return s.google.status();
  });

  app.delete("/api/google/app", async (request) => {
    const d = requireDevice(request);
    s.google.clearAppCredentials(d.userId, { type: "device", id: d.deviceId });
    return s.google.status();
  });

  app.post("/api/accounts/instagram/connect", async (request) => {
    const d = requireDevice(request);
    s.audit.record({ userId: d.userId, actorType: "device", actorId: d.deviceId, action: "account.connect_started", details: { provider: "instagram" } });
    return s.instagram.startConnect(d.userId);
  });

  app.post("/api/accounts/spotify/connect", async (request) => {
    const d = requireDevice(request);
    s.audit.record({ userId: d.userId, actorType: "device", actorId: d.deviceId, action: "account.connect_started", details: { provider: "spotify" } });
    return s.spotify.startConnect(d.userId);
  });

  app.post("/api/accounts/:id/check", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const row = s.integrations.getRow(id);
    if (!row || row.userId !== d.userId) throw new LouError("NOT_FOUND", "Account not found.");
    if (row.provider === "google") await s.google.checkHealth(id).catch(() => undefined);
    if (row.provider === "spotify") await s.spotify.checkHealth(id).catch(() => undefined);
    if (row.provider === "instagram") {
      await s.instagram
        .client(id)
        .me()
        .then(() => s.integrations.setStatus(id, "connected", null))
        .catch((err: LouError) => s.integrations.setStatus(id, err.code === "AUTH_REQUIRED" ? "needs_reauth" : "error", err.message));
    }
    return s.integrations.list(d.userId).find((a) => a.id === id);
  });

  app.delete("/api/accounts/:id", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    s.integrations.disconnect(d.userId, id, { type: "device", id: d.deviceId });
    return { ok: true };
  });

  // ---- Spotify (setup, status, and the compact Now Playing remote) ---------------
  app.get("/api/spotify", async (request) => s.spotify.status(requireDevice(request).userId));

  app.post("/api/spotify/app", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const d = requireDevice(request);
    await s.spotify.saveAppCredentials(d.userId, SpotifyAppCredentialsRequestSchema.parse(request.body), { type: "device", id: d.deviceId });
    return s.spotify.status(d.userId);
  });

  app.delete("/api/spotify/app", async (request) => {
    const d = requireDevice(request);
    s.spotify.clearAppCredentials(d.userId, { type: "device", id: d.deviceId });
    return s.spotify.status(d.userId);
  });

  // Served from a short shared cache so polling clients never hammer Spotify.
  app.get("/api/spotify/player", async (request) => s.spotifyPlayer.playerView(requireDevice(request).userId));

  app.post("/api/spotify/player", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const d = requireDevice(request);
    const body = SpotifyPlayerActionRequestSchema.parse(request.body);
    if (body.action === "play") await s.spotifyPlayer.play(d.userId, {});
    else if (body.action === "pause") await s.spotifyPlayer.pause(d.userId);
    else if (body.action === "next") await s.spotifyPlayer.next(d.userId);
    else if (body.action === "previous") await s.spotifyPlayer.previous(d.userId);
    else {
      if (body.volumePercent === undefined) throw new LouError("VALIDATION_FAILED", "volumePercent is required.");
      await s.spotifyPlayer.setVolume(d.userId, { volumePercent: body.volumePercent });
    }
    return { ok: true };
  });

  // ---- Devices --------------------------------------------------------------------
  app.get("/api/devices", async (request) => {
    const d = requireDevice(request);
    return { items: s.devices.list(d.userId, (id) => s.gateway.isOnline(id), d.deviceId) };
  });

  app.post("/api/devices/pairing-codes", async (request) => {
    const d = requireDevice(request);
    return s.devices.createPairingCode(d.userId, { type: "device", id: d.deviceId });
  });

  app.post("/api/devices/:id/revoke", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    s.devices.revoke(d.userId, id, { type: "device", id: d.deviceId });
    return { ok: true };
  });

  // ---- Skills -----------------------------------------------------------------------
  app.get("/api/skills", async () => ({ items: s.skills.list() }));

  app.get("/api/skills/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    const detail = s.skills.detail(id);
    if (!detail) throw new LouError("NOT_FOUND", "Skill not found.");
    return detail;
  });

  app.post("/api/skills/:id/enable", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    s.skills.setEnabled(id, enabled, { type: "device", id: d.deviceId, userId: d.userId });
    return s.skills.detail(id);
  });

  app.post("/api/skills/:id/rollback", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const { version } = z.object({ version: z.number().int().min(1) }).parse(request.body);
    s.skills.rollback(id, version, { type: "device", id: d.deviceId, userId: d.userId });
    return s.skills.detail(id);
  });

  app.post("/api/skills/versions/:id/activate", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    s.skills.activate(id, { type: "device", id: d.deviceId, userId: d.userId });
    return { ok: true };
  });

  app.post("/api/skills", async (request, reply) => {
    const d = requireDevice(request);
    const { content } = z.object({ content: z.string().min(20).max(20_000) }).parse(request.body);
    const result = s.skills.propose({ content, createdBy: "user", reason: `Created from device ${d.deviceId}` });
    return reply.status(201).send(result);
  });

  // ---- Memory ---------------------------------------------------------------------
  app.get("/api/memories", async (request) => {
    const d = requireDevice(request);
    const q = z.object({ status: z.enum(["active", "proposed"]).optional(), type: MemoryTypeSchema.optional() }).parse(request.query);
    const items = s.memory.list(d.userId, q.status).filter((m) => !q.type || m.type === q.type);
    return { items };
  });

  app.post("/api/memories", async (request, reply) => {
    const d = requireDevice(request);
    const body = CreateMemoryRequestSchema.parse(request.body);
    const memory = await s.memory.create({ userId: d.userId, type: body.type, content: body.content, source: "user", expiresAt: body.expiresAt }, { type: "device", id: d.deviceId });
    return reply.status(201).send(memory);
  });

  app.patch("/api/memories/:id", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    return s.memory.update(d.userId, id, UpdateMemoryRequestSchema.parse(request.body), { type: "device", id: d.deviceId });
  });

  app.delete("/api/memories/:id", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    s.memory.delete(d.userId, id, { type: "device", id: d.deviceId });
    return { ok: true };
  });

  // ---- Proposals (self-improvement) ----------------------------------------------
  app.get("/api/proposals", async (request) => {
    const d = requireDevice(request);
    const q = z.object({ status: z.string().optional() }).parse(request.query);
    return { items: s.improvement?.list(d.userId, q.status) ?? [] };
  });

  app.post("/api/proposals/:id/resolve", async (request) => {
    const d = requireDevice(request);
    const { id } = IdParam.parse(request.params);
    const { accept } = z.object({ accept: z.boolean() }).parse(request.body);
    if (!s.improvement) throw new LouError("NOT_CONFIGURED", "Self-improvement is disabled.");
    await s.improvement.resolve(d.userId, id, accept, { deviceId: d.deviceId });
    return { ok: true };
  });

  // ---- Workflows ------------------------------------------------------------------
  app.get("/api/workflows", async () => ({ items: s.workflows.list() }));

  // ---- Notifications ----------------------------------------------------------------
  app.get("/api/notifications", async (request) => {
    const d = requireDevice(request);
    return { items: s.notifications.list(d.userId) };
  });

  app.post("/api/notifications/:id/:action", async (request) => {
    const d = requireDevice(request);
    const { id, action } = z.object({ id: z.string(), action: z.enum(["read", "dismiss"]) }).parse(request.params);
    s.notifications.setStatus(d.userId, id, action === "read" ? "read" : "dismissed");
    return { ok: true };
  });

  // ---- Audit & settings ---------------------------------------------------------------
  app.get("/api/audit", async (request) => {
    const d = requireDevice(request);
    const q = ListQuery.extend({ runId: z.string().optional() }).parse(request.query);
    return { items: s.audit.list({ userId: d.userId, runId: q.runId, before: q.before, limit: q.limit }) };
  });

  app.get("/api/settings", async () => s.settings.get());

  // ---- Model providers ------------------------------------------------------------------
  app.get("/api/providers", async (request) => {
    const { probe } = z.object({ probe: z.enum(["1", "true"]).optional() }).parse(request.query);
    return { active: s.providers.active(), items: await s.providers.statuses(!!probe) };
  });

  app.patch("/api/settings", async (request) => {
    const d = requireDevice(request);
    return s.settings.update(UpdateSettingsRequestSchema.parse(request.body), { userId: d.userId, deviceId: d.deviceId });
  });

  // ---- Voice --------------------------------------------------------------------------
  app.post("/api/transcribe", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    requireDevice(request);
    if (!s.transcriber) throw new LouError("NOT_CONFIGURED", "Voice input isn't configured on the server.");
    const file = await request.file();
    if (!file) throw new LouError("VALIDATION_FAILED", "Missing audio file.");
    const audio = await file.toBuffer();
    if (audio.length < 1000) throw new LouError("VALIDATION_FAILED", "That recording was too short.");
    const text = await s.transcriber.transcribe(audio, file.filename || "audio.webm", file.mimetype || "audio/webm");
    return { text };
  });
}
