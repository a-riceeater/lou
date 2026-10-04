import { maxRisk, riskRank, type RiskLevel } from "@lou/shared";
import type { ParsedSkill } from "./format";

export interface SkillIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface SkillValidationContext {
  /** Returns the registered risk for a tool, or undefined if it does not exist. */
  toolRisk(toolId: string): RiskLevel | undefined;
}

interface Rule {
  code: string;
  pattern: RegExp;
  message: string;
  /** Skip the match when a negation ("never", "do not") closely precedes it. */
  negatable?: boolean;
}

/**
 * Content rules from AGENT_SYSTEM.md §5. Skills are procedural knowledge; they may
 * reference tools but may never weaken approvals, touch credentials, elevate
 * permissions, or override system instructions.
 */
const RULES: Rule[] = [
  {
    code: "approval_bypass",
    pattern: /\b(skip|bypass|disable|avoid|circumvent|without)\b[^.\n]{0,24}\b(approval|confirmation|confirm|review|asking)\b/gi,
    message: "Instructions must not bypass user approval.",
    negatable: true,
  },
  {
    code: "approval_bypass",
    pattern: /\b(auto[- ]?send|send (it )?(automatically|immediately|right away))\b/gi,
    message: "Skills must not auto-send messages.",
    negatable: true,
  },
  {
    code: "permission_override",
    pattern: /\b(requires_?approval|requiresApproval|risk)\s*[:=]\s*(false|read|none)\b/gi,
    message: "Skills cannot redefine tool permissions.",
  },
  {
    code: "prompt_override",
    pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,30}\b(previous|prior|above|system|developer|safety)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|polic(y|ies)|messages?)\b/gi,
    message: "Skills must not contain system-prompt override language.",
  },
  {
    code: "prompt_override",
    pattern: /\b(you are now|new system prompt|act as (an? )?(admin|root|developer mode))\b/gi,
    message: "Skills must not redefine the assistant's role or instructions.",
  },
  {
    code: "credential_access",
    pattern: /\b(password|passcode|api[ _-]?key|secret[ _-]?key|access[ _-]?token|refresh[ _-]?token|oauth token|credentials?)\b\s*[:=]/gi,
    message: "Skills must not embed credentials.",
  },
  {
    code: "credential_access",
    pattern: /\b(read|extract|export|dump|copy|send|reveal|print)\b[^.\n]{0,30}\b(passwords?|credentials?|tokens?|api keys?|cookies|secrets?)\b/gi,
    message: "Skills must not access credentials.",
    negatable: true,
  },
  {
    code: "privilege_escalation",
    pattern: /\b(grant|give|elevate|escalate|add)\b[^.\n]{0,30}\b(permissions?|privileges?|admin(istrator)? (rights|access)|root access)\b/gi,
    message: "Skills must not elevate permissions.",
    negatable: true,
  },
  {
    code: "privilege_escalation",
    pattern: /\b(sudo|run as administrator|powershell(\.exe)?|cmd\.exe|bash -c|rm -rf|Invoke-Expression|reg add)\b/gi,
    message: "Skills must not run shell commands.",
    negatable: true,
  },
];

const NEGATION = /\b(never|not|no|don't|do not|must not|cannot|can't|without ever)\b[^.\n]{0,16}$/i;

export function validateSkill(skill: ParsedSkill, ctx: SkillValidationContext): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const fm = skill.frontmatter;

  const toolRisks: RiskLevel[] = [];
  for (const toolId of fm.tools) {
    const risk = ctx.toolRisk(toolId);
    if (!risk) issues.push({ severity: "error", code: "unknown_tool", message: `Unknown tool "${toolId}".` });
    else toolRisks.push(risk);
  }
  const required = maxRisk(toolRisks);
  if (riskRank(fm.risk) < riskRank(required)) {
    issues.push({
      severity: "error",
      code: "risk_mismatch",
      message: `Declared risk "${fm.risk}" is lower than referenced tools ("${required}").`,
    });
  }

  if (skill.body.length < 20) issues.push({ severity: "error", code: "empty_body", message: "Skill body is too short." });
  if (skill.body.length > 12_000) issues.push({ severity: "warning", code: "long_body", message: "Skill body is long; consider splitting it." });

  const text = `${fm.description}\n${skill.body}`;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.negatable) {
        const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
        if (NEGATION.test(before) || /\b(only )?after\b/i.test(match[0])) continue;
      }
      issues.push({ severity: "error", code: rule.code, message: `${rule.message} (“${match[0].trim()}”)` });
      break;
    }
  }
  return issues;
}

export function hasErrors(issues: SkillIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
