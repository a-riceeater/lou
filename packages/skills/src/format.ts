import { LouError, RISK_LEVELS } from "@lou/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * Portable SKILL.md format: YAML frontmatter + Markdown body. Compatible with the
 * common agent-skill layout so skills can move to another runtime (e.g. Hermes).
 */
export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case")
    .max(64),
  description: z.string().min(8).max(400),
  version: z.number().int().min(1),
  risk: z.enum(RISK_LEVELS),
  tools: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  /** Original file text. */
  source: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(text: string): ParsedSkill {
  const match = FRONTMATTER.exec(text.replace(/^﻿/, ""));
  if (!match) throw new LouError("VALIDATION_FAILED", "SKILL.md must start with YAML frontmatter delimited by ---");
  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? "");
  } catch (err) {
    throw new LouError("VALIDATION_FAILED", `Invalid frontmatter YAML: ${(err as Error).message}`);
  }
  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`).join("; ");
    throw new LouError("VALIDATION_FAILED", `Invalid frontmatter: ${issues}`);
  }
  return { frontmatter: parsed.data, body: (match[2] ?? "").trim(), source: text };
}

export function serializeSkillMd(frontmatter: SkillFrontmatter, body: string): string {
  const fm: Record<string, unknown> = {
    name: frontmatter.name,
    description: frontmatter.description,
    version: frontmatter.version,
    risk: frontmatter.risk,
    tools: frontmatter.tools,
  };
  if (frontmatter.tags?.length) fm.tags = frontmatter.tags;
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${body.trim()}\n`;
}
