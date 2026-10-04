import { Bm25Index, wrapUntrusted, type Result, type SerializedError } from "@lou/shared";
import type { AnyToolDefinition, ToolFamily, ToolRegistry } from "@lou/tools";
import type { RunState } from "./types";

/**
 * Logic shared by every runtime implementation (custom Luna loop, Codex App
 * Server, …) so tool exposure, result formatting and run bookkeeping behave
 * identically regardless of which model backend drives the run.
 */

export const ENABLE_FAMILY_TOOL = "tools.enable_family";
export const SKILL_READ_TOOL = "skills.read";

/** Model-exposed tools of a family; large families are narrowed to the most relevant tools for `text`. */
export function familyTools(registry: ToolRegistry, families: readonly ToolFamily[], familyId: string, text: string): string[] {
  const defs = registry.byFamily(familyId).filter((d) => d.exposure === "model");
  const max = families.find((f) => f.id === familyId)?.maxTools;
  if (!max || defs.length <= max) return defs.map((d) => d.id);
  const index = new Bm25Index(defs.map((d) => ({ id: d.id, text: `${d.id.replace(/[._]/g, " ")} ${d.description}` })));
  const ranked = index.search(text, max).map((h) => h.id);
  return ranked.length ? ranked : defs.slice(0, max).map((d) => d.id);
}

/** Serializes a tool result for the model. External content is wrapped in the untrusted envelope. */
export function formatToolResult(def: AnyToolDefinition | undefined, result: Result<unknown>, maxChars: number): string {
  const body = result.success
    ? { success: true, data: result.data }
    : { success: false, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } satisfies Omit<SerializedError, "details"> };
  let json = JSON.stringify(body);
  if (json.length > maxChars) json = `${json.slice(0, maxChars)}…[truncated]`;
  return def?.untrustedOutput && result.success ? wrapUntrusted(def.id, json) : json;
}

/**
 * Updates run bookkeeping after a tool result: taint, failure streaks, side
 * effects and loaded skills. Returns tool IDs a loaded skill asks to offer.
 */
export function recordToolOutcome(state: RunState, toolId: string, def: AnyToolDefinition | undefined, result: Result<unknown>): string[] {
  if (!result.success) {
    state.consecutiveFailures++;
    return [];
  }
  state.consecutiveFailures = 0;
  if (def && def.risk !== "read") state.actionsTaken++;
  if (def?.untrustedOutput) state.tainted = true;
  if (toolId !== SKILL_READ_TOOL) return [];
  const skill = result.data as { id?: unknown; tools?: unknown };
  if (typeof skill?.id === "string" && !state.loadedSkills.includes(skill.id)) state.loadedSkills.push(skill.id);
  return Array.isArray(skill?.tools) ? skill.tools.filter((t): t is string => typeof t === "string") : [];
}

/** Provider-safe tool names: the APIs forbid dots (`gmail.search` → `gmail__search`). */
export function toApiName(name: string): string {
  return name.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function fromApiName(name: string): string {
  return name.replace(/__/g, ".");
}
