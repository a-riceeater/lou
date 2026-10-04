# Model providers

Lou can be powered by either backend. Everything else (tools, Gmail, approvals, skills, memory, workflows, events, devices, auditing) is the same for both.

| Provider | Setting | Authentication | Best for |
| --- | --- | --- | --- |
| **OpenAI API** | `AI_PROVIDER=openai_api` (default) | `OPENAI_API_KEY` | Servers with an API key; default model GPT-6 Luna (`LOU_MODEL`) |
| **Codex CLI** | `AI_PROVIDER=codex_cli` | Your existing `codex login` (ChatGPT or API key), stored by Codex in `CODEX_HOME` | Using an eligible ChatGPT/Codex plan instead of an API key |

The setting is only the default. You can switch at any time in **Settings → Assistant model** without restarting the server. New requests use the selected provider. A run waiting for approval finishes on the provider that started it. Every switch is audited (`settings.changed`), and every run records which provider handled it.

## Codex CLI provider

### Install and sign in (on the machine running the Lou server)

```bash
npm install -g @openai/codex
codex login            # browser sign-in with ChatGPT (or: codex login --device-auth on a headless server)
codex --version        # 0.151 or newer recommended
codex login status
```

Then set `AI_PROVIDER=codex_cli` (or choose **Codex CLI** in Settings). `OPENAI_API_KEY` isn't required in this mode. Without it, embeddings fall back to keyword search and voice transcription is unavailable.

Optional settings:

| Variable | Purpose |
| --- | --- |
| `CODEX_PATH` | Full path to `codex` if it isn't on `PATH` (`~` is expanded; npm `.cmd` shims on Windows are handled automatically). `~/.local/bin` is searched even when it isn't on `PATH`. |
| `LOU_CODEX_MODEL` | Model for Codex threads (default: the model configured in Codex) |
| `LOU_CODEX_WORKSPACE` | Empty working directory given to Codex (default `${LOU_DATA_DIR}/codex-workspace`) |
| `LOU_CODEX_TURN_TIMEOUT_SECONDS` | Per-turn timeout (default 300) |
| `CODEX_HOME` | Standard Codex variable; where Codex keeps its login and threads (default `~/.codex`) |

Lou never reads, copies, or stores Codex credentials. Codex manages its own login in `CODEX_HOME`. Lou only sees whether you're signed in, the auth type (ChatGPT, API key) and the plan, and shows those in Settings.

### How it works

Lou runs one persistent `codex app-server --listen stdio://` child process and talks to it with the App Server's newline-delimited JSON-RPC protocol. It never parses terminal output.

```text
Windows palette ─HTTPS/WSS─▶ Lou server ─stdio JSON-RPC─▶ codex app-server
                                 │   ▲                       │
                                 │   └── item/tool/call ◀────┘  (Codex asks to use a Lou tool)
                                 ▼
                 ToolExecutor → ToolPolicyEngine → ApprovalManager → Gmail / devices / …
```

- **Conversations ↔ threads.** Each Lou conversation maps to a Codex thread (`initialize → initialized → thread/start`). The thread ID is saved in `provider_threads`. Later turns reuse the thread, so history isn't re-sent. After a server or App Server restart the thread is resumed with `thread/resume`. If Codex has lost it, Lou starts a new thread seeded with recent history from its own database. Lou's database stays authoritative.
- **Same context as the API runtime.** Each turn carries Lou's system prompt, the relevant memories, the skill index, connected accounts and devices, and security rules, all built by the same context provider.
- **Streaming.** `item/agentMessage/delta` events become `agent.delta` WebSocket frames, so the palette shows the answer as it's written. A turn counts as successful only when Codex reports `turn/completed` with status `completed`. Failed and interrupted turns become clear errors, and **Cancel** sends `turn/interrupt`.
- **Single-shot tasks** (importance classification, workflow drafting, the improvement evaluator) run on ephemeral Codex threads with a JSON `outputSchema`.

### Security: Lou's tools stay authoritative

Codex is a capable coding agent. Lou locks it down so it can't act on its own:

- **Lou's tools are Codex's only tools.** Lou's registered tools are exposed to Codex as *dynamic tools*. Every call arrives at Lou as an `item/tool/call` request and runs through the normal **ToolExecutor → ToolPolicyEngine → ApprovalManager** path. Sending email, Instagram replies, desktop control and destructive actions need the same approvals as with the API provider, edits are hash-bound, and only the approved content is executed.
- **Codex's own capabilities are disabled at launch.** That covers shell and exec, file patching, image viewing, browser and computer use, plugins, apps, sub-agents, web search, image generation and hooks. Lou passes only the feature names your CLI version reports. User-configured MCP servers in `~/.codex/config.toml` are disabled by name. Your personal `AGENTS.md` and project docs are excluded (`project_doc_max_bytes=0`).
- **Threads are restricted.** They run with a `read-only` sandbox, `approvalPolicy: never`, and an empty working directory.
- **Defence in depth.** If Codex still starts a native action (command, file change, MCP or web call), Lou interrupts the turn and fails the run. Codex's own approval requests are always declined. Lou refuses to launch Codex with unsafe arguments (`--dangerously-bypass-approvals-and-sandbox`, `danger-full-access`).
- **Process safety.** Codex is launched with `spawn` and an argument array, never a shell. Prompts travel over stdin. Lou enforces timeouts, caps oversized output, kills the child on server exit, and restarts crashes with bounded backoff (1 s → 30 s, at most 5 restarts per 5 minutes).

### Failures and fallback

Lou never switches providers silently. If a Codex request fails (not signed in, crashed, rate limited), the palette shows what went wrong. If the OpenAI API is configured, it also offers **Try with OpenAI API**. That retry is a one-off, explicit override recorded in the audit log (`run.started` with `providerOverride: true`).

### Older Codex versions

If the installed CLI has no `app-server` command, agent requests fail with an upgrade message. Lou won't run actions through a Codex mode that can't route them via its tools and approvals. Single-shot tasks still work through a compatibility path, `codex exec --json --ephemeral` (structured JSONL events), with the same restrictions.

### Troubleshooting

| Settings shows | Meaning and fix |
| --- | --- |
| **Unavailable**: Codex executable not found | Install with `npm install -g @openai/codex`, or set `CODEX_PATH`. `npm start` and `npm run dev` read `apps/server/.env`, not a `.env` at the repo root. Under systemd, make sure `codex` is on the service's `PATH`. |
| **Unavailable**: CODEX_PATH … doesn't exist as seen by the server | The server process can't see that path. The provided systemd unit runs as `lou` with `ProtectHome=true`, so nothing under `/home` is visible. Install Codex system-wide (below) instead of using a copy in your own home directory. |
| **Unavailable**: CODEX_PATH … isn't readable | The server's OS user lacks permission on the file or a parent directory (Ubuntu home directories are `750`). Install Codex system-wide, or run the server as the user who owns that path. |
| **Not signed in**: Run: `codex login` | Sign in as the **same OS user that runs the Lou server** (see below), then press **Check Codex status**. |
| **Unavailable**: … has no App Server | Update Codex: `npm install -g @openai/codex@latest`. |
| **Unavailable**: MCP servers could not be disabled | A server in `~/.codex/config.toml` couldn't be turned off. Remove it, or point Lou at a dedicated `CODEX_HOME`. |
| **Restarting** | Codex crashed. Lou restarts it with backoff; details are in the server log (`journalctl -u lou`). |

Server logs record Codex startup, the auth type, restarts and errors. They never include credentials, prompts, or account e-mail.

### Running under systemd (Ubuntu)

Codex keeps its login in the service user's `CODEX_HOME`. With the provided unit the `lou` user's home is `/var/lib/lou`, so Codex uses `/var/lib/lou/.codex`, which is writable under the unit's sandbox. Sign in as that user once:

```bash
sudo npm install -g @openai/codex
sudo -u lou -H codex login --device-auth      # follow the printed URL and code
sudo -u lou -H codex login status
echo 'AI_PROVIDER=codex_cli' | sudo tee -a /etc/lou/lou.env
sudo systemctl restart lou
```
