import { LouError } from "@lou/shared";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedDevice, DeviceRegistry } from "../devices/registry";

declare module "fastify" {
  interface FastifyRequest {
    device?: AuthenticatedDevice;
  }
}

/** Extracts a bearer token from the Authorization header or the WebSocket subprotocol list. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  // Browsers cannot set headers on WebSocket upgrades; accept `bearer.<token>` as a subprotocol.
  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols === "string") {
    const entry = protocols.split(",").map((p) => p.trim()).find((p) => p.startsWith("bearer."));
    if (entry) return entry.slice(7);
  }
  return undefined;
}

export function authenticate(devices: DeviceRegistry) {
  return async (request: FastifyRequest): Promise<void> => {
    const device = devices.authenticate(bearerToken(request));
    if (!device) throw new LouError("UNAUTHORIZED", "This device is not signed in or was revoked.");
    request.device = device;
  };
}

export function requireDevice(request: FastifyRequest): AuthenticatedDevice {
  if (!request.device) throw new LouError("UNAUTHORIZED", "Not authenticated.");
  return request.device;
}
