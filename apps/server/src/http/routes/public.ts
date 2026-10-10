import { DeviceRegisterRequestSchema } from "@lou/protocol";
import { LouError, toLouError } from "@lou/shared";
import type { FastifyInstance } from "fastify";
import type { Services } from "../../container";
import { resultPage } from "../pages";

/** Unauthenticated routes: health, pairing, OAuth callbacks, signed webhooks. */
export async function publicRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get("/health", async () => {
    let db = "ok";
    try {
      s.db.$client.prepare("select 1").get();
    } catch {
      db = "error";
    }
    return {
      status: db === "ok" ? "ok" : "degraded",
      version: s.config.version,
      uptimeSeconds: Math.round(process.uptime()),
      db,
      provider: s.providers.active(),
      model: s.providers.modelLabel(),
      codex: s.codex.snapshot().state,
      claude: s.claude.snapshot().state,
      integrations: { gmail: s.google.configured, instagram: s.instagram.configured, spotify: s.spotify.configured },
    };
  });

  app.post(
    "/api/devices/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = DeviceRegisterRequestSchema.parse(request.body);
      const result = s.devices.register(body, request.ip);
      return reply.status(201).send(result);
    },
  );

  app.get("/oauth/google/callback", async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    try {
      const { email } = await s.google.handleCallback(q);
      return reply.type("text/html").send(resultPage("Gmail connected", `${email} is ready. You can close this tab.`, true));
    } catch (err) {
      const e = toLouError(err);
      request.log.warn({ code: e.code }, "google oauth callback failed");
      return reply.status(400).type("text/html").send(resultPage("Couldn't connect Gmail", e.message, false));
    }
  });

  app.get("/oauth/spotify/callback", async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    try {
      const { displayName } = await s.spotify.handleCallback(q);
      return reply.type("text/html").send(resultPage("Spotify connected", `${displayName} is connected. You can close this tab and ask Lou to play something.`, true));
    } catch (err) {
      const e = toLouError(err);
      request.log.warn({ code: e.code }, "spotify oauth callback failed");
      return reply.status(400).type("text/html").send(resultPage("Couldn't connect Spotify", e.message, false));
    }
  });

  app.get("/oauth/instagram/callback", async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string; error_reason?: string };
    try {
      const { username } = await s.instagram.handleCallback(q);
      return reply.type("text/html").send(resultPage("Instagram connected", `@${username} is ready. You can close this tab.`, true));
    } catch (err) {
      const e = toLouError(err);
      request.log.warn({ code: e.code }, "instagram oauth callback failed");
      return reply.status(400).type("text/html").send(resultPage("Couldn't connect Instagram", e.message, false));
    }
  });

  // Instagram webhooks need the raw body for HMAC verification.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.get("/webhooks/instagram", async (request, reply) => {
      const challenge = s.instagram.verifyWebhookChallenge(request.query as Record<string, string>);
      return reply.type("text/plain").send(challenge);
    });
    scope.post("/webhooks/instagram", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (request, reply) => {
      if (s.settings.get().monitoringDisabled) return reply.status(200).send({ ok: true, ignored: true });
      const raw = request.body as Buffer;
      if (!Buffer.isBuffer(raw)) throw new LouError("VALIDATION_FAILED", "Expected JSON body.");
      await s.instagram.handleWebhook(raw, request.headers["x-hub-signature-256"] as string | undefined, s.events);
      return reply.status(200).send({ ok: true });
    });
  });
}
