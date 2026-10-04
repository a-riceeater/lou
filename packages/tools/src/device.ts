import { z } from "zod";
import type { ToolDefinition } from "./types";

/**
 * Catalog of device tools. The server registers these with a handler that sends a
 * signed command to the target device; the Windows agent mirrors the input shapes
 * in `Lou.Agent/Tools/*`. Every device tool takes an optional `deviceId`; when
 * omitted the server targets the device that made the request.
 */

const deviceId = z.string().optional().describe("Target device ID. Omit to use the device the user is on.");

export const KNOWN_FOLDERS = ["documents", "downloads", "desktop", "pictures", "music", "videos", "home"] as const;

export const DeviceCapability = {
  openApp: "open_app",
  openFile: "open_file",
  openUrl: "open_url",
  searchFiles: "search_files",
  clipboardRead: "clipboard_read",
  clipboardWrite: "clipboard_write",
  activeWindow: "active_window",
  uiAutomation: "ui_automation",
  notifications: "notifications",
} as const;

const base = { family: "device", executionTarget: "device" as const, exposure: "model" as const };

export const deviceOpenApp: ToolDefinition<{ deviceId?: string; name: string }> = {
  ...base,
  id: "device.open_app",
  title: "Opening an app",
  description: "Launch an installed application on the user's computer by its display name (e.g. \"Spotify\", \"Notepad\").",
  input: z.object({ deviceId, name: z.string().min(1).max(120) }),
  output: z.object({ launched: z.string() }),
  risk: "write",
  requiresApproval: false,
  untrustedOutput: false,
  capability: DeviceCapability.openApp,
};

export const deviceOpenUrl: ToolDefinition<{ deviceId?: string; url: string }> = {
  ...base,
  id: "device.open_url",
  title: "Opening a link",
  description: "Open an http(s) URL in the user's default browser.",
  input: z.object({ deviceId, url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "Only http(s) URLs") }),
  output: z.object({ opened: z.boolean() }),
  risk: "write",
  requiresApproval: false,
  untrustedOutput: false,
  capability: DeviceCapability.openUrl,
};

export const deviceOpenFile: ToolDefinition<{ deviceId?: string; path: string }> = {
  ...base,
  id: "device.open_file",
  title: "Opening a file",
  description: "Open a file with its default application. Use a path returned by device.search_files.",
  input: z.object({ deviceId, path: z.string().min(1).max(1024) }),
  output: z.object({ opened: z.boolean() }),
  risk: "write",
  requiresApproval: false,
  untrustedOutput: false,
  capability: DeviceCapability.openFile,
};

export const deviceSearchFiles: ToolDefinition<{ deviceId?: string; query: string; folder?: (typeof KNOWN_FOLDERS)[number]; limit?: number }> = {
  ...base,
  id: "device.search_files",
  title: "Searching files",
  description: "Search file names in the user's personal folders. Returns paths, sizes and modified times; never file contents.",
  input: z.object({
    deviceId,
    query: z.string().min(1).max(200),
    folder: z.enum(KNOWN_FOLDERS).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  output: z.object({ files: z.array(z.object({ path: z.string(), name: z.string(), size: z.number(), modifiedAt: z.string() })) }),
  risk: "read",
  requiresApproval: false,
  untrustedOutput: true,
  capability: DeviceCapability.searchFiles,
};

export const deviceGetActiveWindow: ToolDefinition<{ deviceId?: string }> = {
  ...base,
  id: "device.get_active_window",
  title: "Checking the active window",
  description: "Get the title and process name of the window the user was using before opening the assistant.",
  input: z.object({ deviceId }),
  output: z.object({ title: z.string(), processName: z.string() }),
  risk: "read",
  requiresApproval: false,
  untrustedOutput: true,
  capability: DeviceCapability.activeWindow,
};

export const deviceGetClipboard: ToolDefinition<{ deviceId?: string }> = {
  ...base,
  id: "device.get_clipboard",
  title: "Reading the clipboard",
  description: "Read the current text on the user's clipboard.",
  input: z.object({ deviceId }),
  output: z.object({ text: z.string() }),
  risk: "read",
  requiresApproval: false,
  untrustedOutput: true,
  capability: DeviceCapability.clipboardRead,
};

export const deviceSetClipboard: ToolDefinition<{ deviceId?: string; text: string }> = {
  ...base,
  id: "device.set_clipboard",
  title: "Copying to the clipboard",
  description: "Replace the clipboard contents with the given text.",
  input: z.object({ deviceId, text: z.string().max(100_000) }),
  output: z.object({ copied: z.boolean() }),
  risk: "write",
  requiresApproval: false,
  untrustedOutput: false,
  capability: DeviceCapability.clipboardWrite,
};

export const deviceGetUiTree: ToolDefinition<{ deviceId?: string; maxDepth?: number; maxNodes?: number }> = {
  ...base,
  id: "device.get_ui_tree",
  title: "Looking at the window",
  description:
    "Read the accessibility tree of the foreground window. Returns elements with temporary IDs (valid until the UI changes), roles and names.",
  input: z.object({ deviceId, maxDepth: z.number().int().min(1).max(12).optional(), maxNodes: z.number().int().min(1).max(400).optional() }),
  output: z.object({
    treeId: z.string(),
    window: z.string(),
    elements: z.array(z.object({ id: z.string(), role: z.string(), name: z.string(), depth: z.number(), enabled: z.boolean() })),
  }),
  risk: "read",
  requiresApproval: false,
  untrustedOutput: true,
  capability: DeviceCapability.uiAutomation,
};

export const deviceInvokeUiElement: ToolDefinition<{ deviceId?: string; elementId: string; action: "invoke" | "focus" | "set_value"; value?: string }> = {
  ...base,
  id: "device.invoke_ui_element",
  title: "Using the app",
  description: "Invoke, focus, or set the value of an element returned by device.get_ui_tree. Element IDs expire when the UI changes.",
  input: z.object({
    deviceId,
    elementId: z.string().min(1).max(64),
    action: z.enum(["invoke", "focus", "set_value"]),
    value: z.string().max(10_000).optional(),
  }),
  output: z.object({ done: z.boolean() }),
  risk: "write",
  requiresApproval: true,
  untrustedOutput: false,
  capability: DeviceCapability.uiAutomation,
};

export const deviceShowNotification: ToolDefinition<{ deviceId?: string; title: string; body: string }> = {
  ...base,
  id: "device.show_notification",
  title: "Showing a notification",
  description: "Show a native desktop notification on the user's computer.",
  input: z.object({ deviceId, title: z.string().min(1).max(120), body: z.string().max(500) }),
  output: z.object({ shown: z.boolean() }),
  risk: "write",
  requiresApproval: false,
  untrustedOutput: false,
  capability: DeviceCapability.notifications,
};

export const DEVICE_TOOLS = [
  deviceOpenApp,
  deviceOpenUrl,
  deviceOpenFile,
  deviceSearchFiles,
  deviceGetActiveWindow,
  deviceGetClipboard,
  deviceSetClipboard,
  deviceGetUiTree,
  deviceInvokeUiElement,
  deviceShowNotification,
] as const;
