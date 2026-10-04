import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Services } from "../container";
import { errorHandler } from "./errors";
import { apiRoutes } from "./routes/api";
import { publicRoutes } from "./routes/public";
import { wsRoutes } from "./routes/ws";

export async function buildApp(s: Services): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: s.logger as unknown as FastifyBaseLogger,
    trustProxy: s.config.trustProxy,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  if (s.config.corsOrigins.length) await app.register(cors, { origin: s.config.corsOrigins, credentials: false });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
      // Echo our protocol when the client offered it (browser dev mode sends `lou.v1, bearer.<token>`).
      handleProtocols: (protocols) => (protocols.has("lou.v1") ? "lou.v1" : false),
    },
  });

  await app.register(async (scope) => publicRoutes(scope, s));
  await app.register(async (scope) => wsRoutes(scope, s));
  await app.register(async (scope) => apiRoutes(scope, s));
  return app;
}
