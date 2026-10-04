import type { FastifyInstance } from "fastify";
import type { Services } from "../../container";
import { bearerToken } from "../auth";

/**
 * Persistent device session. Devices connect outbound (no inbound ports on
 * desktops). Authentication happens before the upgrade completes; unknown or
 * revoked credentials get a 401 and never reach the gateway.
 */
export async function wsRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const device = s.devices.authenticate(bearerToken(request));
        if (!device) {
          s.audit.record({ actorType: "system", action: "device.auth_failed", details: { remoteAddr: request.ip, channel: "ws" } });
          return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid device credential." } });
        }
        request.device = device;
      },
    },
    (socket, request) => {
      s.gateway.accept(socket, request.device!, request.ip);
    },
  );
}
