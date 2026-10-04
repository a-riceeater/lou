# AGENT_SYSTEM.md

# Agent Runtime, Skills, Learning, and Memory

## 1. Agent Philosophy

The assistant should be expandable without becoming uncontrolled.

The system should learn:

- procedures
- preferences
- reliable workflows
- useful mappings between user intent and tools

The system should not autonomously give itself new unrestricted powers.

Separate:

```text
Tools      = capabilities
Skills     = procedural knowledge
Workflows  = deterministic repeatable sequences
Memory     = facts/preferences
Code       = executable logic
```

---

# 2. Skill Lifecycle

States:

```text
proposed
validated
active
deprecated
rolled_back
```

A learned skill should not immediately replace an existing active skill without validation.

---

# 3. Skill Creation Trigger

A skill may be proposed when:

- the user repeats a task
- the agent discovers a non-obvious successful process
- the user manually corrects the same behavior more than once
- a tool sequence consistently succeeds
- a procedure would significantly reduce future reasoning

Do not create a skill for one-off trivial tasks.

---

# 4. Skill Evaluation

After selected successful runs, execute an improvement pass:

```text
Review:
- what worked?
- what failed?
- did the user correct anything?
- what sequence was reusable?
- can part of the process become deterministic?
```

Output one of:

```text
NO_CHANGE
MEMORY_PROPOSAL
SKILL_PROPOSAL
SKILL_PATCH
WORKFLOW_PROPOSAL
```

---

# 5. Skill Validation

Before activation:

- validate frontmatter
- verify referenced tools exist
- verify risk classification
- reject instructions that attempt to bypass approval
- reject hidden credential usage
- reject instructions that elevate permissions
- ensure no system-prompt override language
- run optional dry-run evaluation

---

# 6. Tool Authority

A skill may say:

> use gmail.reply after approval

A skill may not redefine:

```text
gmail.reply.requiresApproval = false
```

Permissions are controlled by the Tool Registry and policy engine only.

---

# 7. Agent-Generated Code

Later versions may allow helper code generation.

Generated code must:

- live in a sandbox
- have declared inputs/outputs
- have declared filesystem/network access
- pass tests
- be reviewable
- never automatically gain credential access
- require explicit approval before installation as a new executable tool

Generated helper code is not automatically a tool.

---

# 8. Memory Types

Recommended categories:

```text
preference
identity
account_mapping
contact
project
routine
notification_rule
environment
```

Each memory:

```ts
interface Memory {
  id: string;
  type: string;
  content: string;
  source: "user" | "agent-inferred";
  confidence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
```

Agent-inferred memories should have lower trust than explicit user statements.

---

# 9. Notification Learning

The assistant should learn notification preferences separately.

Examples:

```text
"Emails from band director are always important."
"Do not notify for Instagram reactions."
"Notify me for schedule changes."
"Marketing emails should never interrupt me."
```

Where possible, convert stable preferences into deterministic rules before model classification.

---

# 10. Important Message Classification

Suggested model output:

```json
{
  "importance": 0.86,
  "needsResponse": true,
  "urgency": "soon",
  "category": "school",
  "summary": "Teacher is asking whether you can attend Friday.",
  "reasonCode": "direct_question"
}
```

Do not expose hidden reasoning.

Use compact reason codes.

---

# 11. Self-Improvement Boundaries

The agent may automatically:

- refine low-risk skills
- save low-risk preferences
- improve search/query techniques
- create read-only workflows

The agent should require approval for:

- workflows that send messages
- workflows that modify data
- changes involving shell commands
- code installation
- external service authorization
- destructive operations
- changes to security policy

---

# 12. Skill Retrieval

Do not load every skill into context.

Use a skill index:

```json
[
  {
    "id": "draft-school-email",
    "description": "Draft concise professional replies to teachers and staff."
  },
  {
    "id": "triage-instagram-dms",
    "description": "Evaluate new Instagram DMs for importance."
  }
]
```

Select relevant skills, then load full content.

---

# 13. Tool Retrieval

Same principle for tools.

Do not provide 500 tools to Luna.

Tool discovery:

```text
Request
  ↓
tool family classifier
  ↓
relevant tool subset
  ↓
model
```

Example:

```text
"Reply to the latest club email."

Tool subset:
- gmail.search
- gmail.read_thread
- approval.create
- gmail.reply
```

---

# 14. Runtime States

Agent run states:

```text
created
reasoning
waiting_for_tool
waiting_for_approval
resuming
completed
failed
cancelled
```

Persist the state after every external tool call.

---

# 15. Failure Handling

Tools should return structured errors:

```json
{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Instagram authorization expired."
  }
}
```

The model should not guess about failed tool output.

Retry only when the error is retryable.

---

# 16. Confidence

Use confidence where it helps control behavior.

Examples:

- ambiguous contact match
- uncertain target account
- potentially destructive file operation
- multiple emails matching a vague query

Low confidence on a high-risk action should force clarification or approval.

---

# 17. Auditability

Store:

- user request
- tools invoked
- tool arguments
- tool results
- approval decisions
- skills loaded
- skill changes
- model used
- timing
- final output

Do not store hidden chain-of-thought.

---

# 18. Example Learned Workflow

User repeatedly asks:

> Reply to the latest club inquiry.

The system may learn:

```text
Skill:
reply-club-inquiry

1. Search club inbox for newest unread direct question.
2. Read thread.
3. Draft concise reply using club tone.
4. Show editable approval.
5. Send only after approval.
6. Mark thread handled after successful send.
```

This becomes reusable procedural knowledge without changing Gmail permissions.
