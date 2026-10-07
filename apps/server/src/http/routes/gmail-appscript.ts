import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../../container";
import { ScriptMessage } from "../../integrations/google/script-protocol";

const Envelope = z.object({ integrationId: z.string().min(1).max(64), protocolVersion: z.literal(1) });
const CommandId = z.object({ id: z.string().min(1).max(64) });
/** Separate auth scope: installation credentials cannot call device or general account APIs. */
export async function gmailAppsScriptRoutes(app: FastifyInstance, s: Services) {
  app.addHook("preHandler", async request => {
    const body = Envelope.parse(request.body);
    s.gmailScript.authenticate(body.integrationId, request.headers.authorization?.replace(/^Bearer /, ""));
  });
  const options = { bodyLimit: 900_000, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  const base = "/api/integrations/gmail-appscript";
  app.post(`${base}/register`, options, async request => {
    const body = Envelope.extend({ address: z.string().email().max(320).optional() }).parse(request.body);
    return s.gmailScript.register(body.integrationId, body.address?.toLowerCase());
  });
  app.post(`${base}/heartbeat`, options, async request => {
    const body = Envelope.extend({ state: z.enum(["syncing", "connected", "error", "authorization_required"]), error: z.string().max(1000).optional() }).parse(request.body);
    return s.gmailScript.heartbeat(body.integrationId, body.state, body.error);
  });
  app.post(`${base}/sync`, options, async request => {
    const body = Envelope.extend({ messages: z.array(ScriptMessage).max(25), cursor: z.string().max(2000) }).parse(request.body);
    return s.gmailScript.sync(body.integrationId, body.messages, body.cursor);
  });
  app.post(`${base}/commands`, options, async request => s.gmailScript.pending(Envelope.parse(request.body).integrationId));
  app.post(`${base}/commands/:id/claim`, options, async request => s.gmailScript.claim(Envelope.parse(request.body).integrationId, CommandId.parse(request.params).id));
  app.post(`${base}/commands/:id/result`, options, async request => {
    const body = Envelope.extend({ result: z.unknown().optional(), error: z.string().min(1).max(1000).optional() }).parse(request.body);
    return s.gmailScript.complete(body.integrationId, CommandId.parse(request.params).id, body.result, body.error);
  });
}
