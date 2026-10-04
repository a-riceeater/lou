import { z } from "zod";
import { ErrorDtoSchema } from "./common";

/**
 * React ↔ C# bridge over WebView2 `postMessage` (DESKTOP_CLIENT.md §5).
 *
 * The React UI never holds the device credential. All server traffic goes through
 * the native host (`api.request`), which attaches credentials and enforces local
 * policy. Server push frames arrive as `native.event` with event `server.message`.
 */

export const NativeRequestSchema = z.object({
  type: z.literal("native.request"),
  requestId: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type NativeRequest = z.infer<typeof NativeRequestSchema>;

export const NativeResponseSchema = z.object({
  type: z.literal("native.response"),
  requestId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: ErrorDtoSchema.optional(),
});
export type NativeResponse = z.infer<typeof NativeResponseSchema>;

export const NativeEventSchema = z.object({
  type: z.literal("native.event"),
  event: z.string(),
  payload: z.unknown(),
});
export type NativeEvent = z.infer<typeof NativeEventSchema>;

/** Methods the native host implements. Params/results are documented in docs/PROTOCOL.md. */
export const NATIVE_METHODS = [
  "api.request",
  "app.info",
  "app.openExternal",
  "window.hide",
  "window.show",
  "window.resize",
  "pairing.complete",
  "pairing.reset",
  "clipboard.read",
  "clipboard.write",
  "settings.get",
  "settings.set",
] as const;
export type NativeMethod = (typeof NATIVE_METHODS)[number];

export const NATIVE_EVENTS = [
  "server.message",
  "connection.state",
  "window.shown",
  "window.hidden",
  "palette.prefill",
] as const;
export type NativeEventName = (typeof NATIVE_EVENTS)[number];

export const ConnectionStateSchema = z.object({
  state: z.enum(["unpaired", "connecting", "online", "offline", "revoked"]),
  serverUrl: z.string().nullable(),
  deviceId: z.string().nullable(),
  error: z.string().nullable().optional(),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ApiRequestParamsSchema = z.object({
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  path: z.string().startsWith("/api/"),
  body: z.unknown().optional(),
});
export type ApiRequestParams = z.infer<typeof ApiRequestParamsSchema>;

export const ApiResponseSchema = z.object({
  status: z.number().int(),
  body: z.unknown(),
});
export type ApiResponse = z.infer<typeof ApiResponseSchema>;

export const WindowShownSchema = z.object({ surface: z.enum(["palette", "app"]) });
export type WindowShown = z.infer<typeof WindowShownSchema>;
