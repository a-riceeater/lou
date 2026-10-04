import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSkillMd, type ParsedSkill } from "./format";

export interface SkillFile {
  /** Path relative to the skills root, e.g. `email/reply-to-email/SKILL.md`. */
  path: string;
  /** Category folder, e.g. `email`. */
  category: string;
  skill: ParsedSkill;
}

export interface SkillLoadError {
  path: string;
  message: string;
}

/** Recursively loads every SKILL.md under `root`. Invalid files are reported, not thrown. */
export async function loadSkillDirectory(root: string): Promise<{ skills: SkillFile[]; errors: SkillLoadError[] }> {
  const skills: SkillFile[] = [];
  const errors: SkillLoadError[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "SKILL.md") {
        const rel = relative(root, full).replace(/\\/g, "/");
        try {
          const skill = parseSkillMd(await readFile(full, "utf8"));
          skills.push({ path: rel, category: rel.split("/")[0] ?? "general", skill });
        } catch (err) {
          errors.push({ path: rel, message: (err as Error).message });
        }
      }
    }
  }

  await walk(root);
  return { skills, errors };
}
