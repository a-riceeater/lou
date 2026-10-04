import { LouError } from "@lou/shared";
import { z } from "zod";
import type { AnyToolDefinition, AnyToolHandler, ModelToolSpec, ToolDefinition, ToolHandler } from "./types";

const TOOL_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/;

interface Entry {
  definition: AnyToolDefinition;
  handler: AnyToolHandler;
}

/**
 * Holds every executable capability. Definitions are frozen on registration so no
 * downstream code (runtime, skills, model output) can alter risk or approval flags.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly specCache = new Map<string, ModelToolSpec>();

  register<I, O>(definition: ToolDefinition<I, O>, handler: ToolHandler<I, O>): void {
    if (!TOOL_ID.test(definition.id)) throw new Error(`Invalid tool id "${definition.id}"`);
    if (this.entries.has(definition.id)) throw new Error(`Tool "${definition.id}" is already registered`);
    if ((definition.risk === "destructive" || definition.risk === "privileged") && !definition.requiresApproval) {
      throw new Error(`Tool "${definition.id}" with risk ${definition.risk} must require approval`);
    }
    if (definition.editableFields?.length && !handler.prepare) {
      throw new Error(`Tool "${definition.id}" declares editable fields but has no prepare()`);
    }
    const frozen = Object.freeze({ ...definition, allowedDevices: definition.allowedDevices && Object.freeze([...definition.allowedDevices]), editableFields: definition.editableFields && Object.freeze([...definition.editableFields]) });
    this.entries.set(definition.id, { definition: frozen as AnyToolDefinition, handler: handler as AnyToolHandler });
  }

  unregister(id: string): void {
    this.entries.delete(id);
    this.specCache.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): AnyToolDefinition | undefined {
    return this.entries.get(id)?.definition;
  }

  require(id: string): AnyToolDefinition {
    const def = this.get(id);
    if (!def) throw new LouError("NOT_FOUND", `Unknown tool "${id}"`);
    return def;
  }

  handler(id: string): AnyToolHandler {
    const entry = this.entries.get(id);
    if (!entry) throw new LouError("NOT_FOUND", `Unknown tool "${id}"`);
    return entry.handler;
  }

  list(): AnyToolDefinition[] {
    return [...this.entries.values()].map((e) => e.definition);
  }

  families(): string[] {
    return [...new Set(this.list().map((d) => d.family))].sort();
  }

  byFamily(family: string): AnyToolDefinition[] {
    return this.list().filter((d) => d.family === family);
  }

  /** JSON Schema for a tool's input, for documentation and the model. */
  inputJsonSchema(id: string): Record<string, unknown> {
    const def = this.require(id);
    return toJsonSchema(def.input);
  }

  outputJsonSchema(id: string): Record<string, unknown> | undefined {
    const def = this.require(id);
    return def.output ? toJsonSchema(def.output) : undefined;
  }

  /** Model-facing specs for the given tool IDs only (progressive disclosure). */
  modelSpecs(ids: Iterable<string>): ModelToolSpec[] {
    const out: ModelToolSpec[] = [];
    for (const id of ids) {
      const def = this.get(id);
      if (!def || def.exposure !== "model") continue;
      let spec = this.specCache.get(id);
      if (!spec) {
        spec = { name: id, description: def.description, parameters: toJsonSchema(def.input) };
        this.specCache.set(id, spec);
      }
      out.push(spec);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
