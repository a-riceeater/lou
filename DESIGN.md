# DESIGN.md

# Product Design

## 1. Product

A personal AI assistant that feels closer to a system service than a chatbot.

It should be available from:

- Windows
- macOS
- iPhone
- optional web interface

The assistant should be fast to invoke and disappear when no longer needed.

---

# 2. Main Interaction

Primary Windows interaction:

```text
Alt + Space
```

opens a compact floating assistant.

Example:

```text
┌──────────────────────────────────────────────┐
│ Ask anything...                              │
└──────────────────────────────────────────────┘
```

After a command:

```text
┌──────────────────────────────────────────────┐
│ Reply to Sarah                               │
│                                              │
│ Sounds good. I'll be there around 6 PM.      │
│                                              │
│                         Cancel       Send     │
└──────────────────────────────────────────────┘
```

The user should not have to open a large chatbot window for routine actions.

---

# 3. Design Principles

- native-feeling
- minimal
- clean
- responsive
- low visual noise
- typography-led hierarchy
- subtle motion
- few visible controls at once
- progressive disclosure
- no unnecessary explanatory labels

Avoid mimicking Windows utility interfaces.

The visual direction may borrow from modern Apple UI principles while remaining appropriate for Windows.

---

# 4. Main Surfaces

## Assistant Overlay

Used for:

- commands
- short answers
- approvals
- drafts
- tool progress
- voice input

## Inbox

Unified assistant attention feed:

- important email
- Instagram DMs
- calendar changes
- system alerts

Not a replacement for the original apps.

## History

Shows:

- recent commands
- completed actions
- approvals
- failed actions

## Skills

Shows:

- installed skills
- learned skills
- version history
- enable/disable
- rollback

## Accounts

Shows:

- Gmail
- Instagram
- MCP connections
- account health
- reauthorization status

## Devices

Shows:

- connected devices
- capabilities
- last seen
- revoke

---

# 5. Notifications

Notifications should be concise and actionable.

Example:

```text
Mr. Smith needs a response before tomorrow.

He is asking whether you can attend Friday.

Reply    Open    Dismiss
```

Do not notify for every event.

The system should learn what deserves interruption.

---

# 6. Voice

Voice is an input method, not a separate product mode.

Flow:

```text
wake / hotkey
↓
record
↓
transcribe
↓
same agent runtime
```

The UI should show transcription before a destructive or consequential action if ambiguity matters.

---

# 7. Editing Before Action

Generated replies should open directly as editable content.

Do not require:

```text
Generate
↓
open separate editor
↓
confirm
```

Instead:

```text
Generate draft
↓
editable immediately
↓
Send
```

---

# 8. Cross-Device Continuity

A task can begin on one device and be approved on another.

Example:

```text
PC:
"Reply to latest club email."

Server generates draft.

Phone:
Push notification with approval.

User edits on phone.

Server sends email.
```

---

# 9. Error Design

Prefer actionable errors:

```text
Instagram needs you to sign in again.
Reconnect
```

instead of:

```text
OAuthException 190
```

Developer details may be expandable.

---

# 10. Future Expansion

The design must allow:

- Discord
- additional social networks
- home automation
- server monitoring
- custom MCP servers
- browser automation
- user-created workflows
- agent-created skills
