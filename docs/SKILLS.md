# Skills, memory, workflows and self-improvement

```text
Tools      = capabilities (with permissions)      packages/tools, apps/server/src/**/tools
Skills     = procedural knowledge (SKILL.md)       skills/, skill_versions table
Workflows  = deterministic step sequences          apps/server/src/workflows
Memory     = facts and preferences                 memories table
```

## SKILL.md format

Portable YAML frontmatter and a Markdown body:

```md
---
name: reply-to-email
description: Find a specific email and reply to it in the user's voice, with an editable approval before sending.
version: 1
risk: write
tools:
  - gmail.search
  - gmail.read_thread
  - gmail.reply
tags: [email]
---

# Trigger
…
# Procedure
1. …
# Notes
…
```

Built-in skills live in `skills/<category>/<name>/SKILL.md` and are synced into the database at startup. Content changes become new versions.

### Progressive disclosure

Each run gets a compact index of the top four relevant skills (ID and description only, BM25-ranked). The model loads a full skill with `skills.read`. Loading a skill offers the model the tools it lists, but **policy still governs execution**: a skill can never make `gmail.reply` skip approval.

### Validation (before any version can become active)

- Frontmatter schema; kebab-case name.
- Every referenced tool exists.
- Declared `risk` ≥ the highest risk of its tools.
- No approval bypass ("send without asking", "auto-send"; negated phrasing like "never send without approval" is fine).
- No permission overrides (`requiresApproval: false`), system-prompt overrides, embedded or exfiltrated credentials, privilege escalation, or shell commands.

Validation runs again at activation time.

### Lifecycle

`proposed → active → deprecated / rolled_back`, or `rejected`. Every change is a new row in `skill_versions` with author (`builtin`, `user`, `agent`), source run, reason, issues, and success/failure counts. Actions (all audited): enable/disable, activate a version, roll back to a version. Learned skills are also exported to `${LOU_DATA_DIR}/skills/<id>/SKILL.md` for portability, for example to a Hermes runtime.

UI: **Skills** lists installed and learned skills, shows versions with **Use this version**, and **Suggested** proposals with Keep/Discard.

## Memory

Types: `preference, identity, account_mapping, contact, project, routine, notification_rule, environment`. Each memory has source (`user` | `agent-inferred`), confidence, timestamps, optional expiry, and status (`active` | `proposed`).

- Retrieval blends embedding similarity (`LOU_EMBEDDING_MODEL`, when an API key is set) with BM25, weighted by confidence. Each run gets about six relevant memories.
- Agent-inferred memories are capped at 0.8 confidence and labelled as inferred in the model context. Editing or accepting one turns it into a user statement.
- Content that looks like a password, token, API key, or card number is refused.
- The model can save memories with `memory.save` (escalated to approval after reading external content, so emails can't plant memories).
- UI: **Memory** to add, edit, forget, and accept or discard suggestions.

## Workflows

```json
{
  "id": "reply-to-email",
  "inputs": { "threadId": {…}, "instruction": {…}, "accountId": {…, "required": false} },
  "steps": [
    { "id": "read",  "tool": "gmail.read_thread", "input": { "threadId": "{{inputs.threadId}}" } },
    { "id": "draft", "model": "draft_reply", "input": { "instruction": "{{inputs.instruction}}", "thread": "{{steps.read}}" } },
    { "id": "send",  "tool": "gmail.reply", "input": { "messageId": "{{steps.read.messages.-1.id}}", "body": "{{steps.draft.body}}" } }
  ]
}
```

The agent chooses a workflow (`workflow.list`, `workflow.run`); the engine executes the fixed steps. Every tool step goes through the same ToolExecutor and policy. Approval-gated steps pause the workflow (`waiting_for_approval`) and the engine resumes it after the decision. Workflows are versioned. Proposed workflows are validated (known, non-internal tools) and start disabled.

## Self-improvement

After selected successful runs (user requests that used tools; throttled), the **improvement evaluator** sends Luna a compact, reasoning-free summary: request, tool sequence, approvals and whether you edited them, loaded skills, similar recent requests, and the available tools. It returns one of:

| Decision | What happens |
| --- | --- |
| `NO_CHANGE` | Nothing (audited) |
| `MEMORY_PROPOSAL` | Preferences are saved as inferred (low trust). Other types wait in Memory → Suggested |
| `SKILL_PROPOSAL` / `SKILL_PATCH` | A new skill version is created and validated. **Risk is computed by the server from the registry**, and unknown tools are dropped |
| `WORKFLOW_PROPOSAL` | Recorded for review |

Only read-only skills may auto-activate, and only if **Let Lou adopt read-only skills** is on. Anything that can act always needs your approval. The agent can never create tools, grant permissions, touch credentials, or install code.

## Generated helper code (future)

Not enabled. The architecture reserves it: generated code would run in a sandbox (no network, temp workspace only, no credentials, restricted shell), require tests and declared I/O, and need explicit approval before installation as a tool (SECURITY.md §10, AGENT_SYSTEM.md §7).
