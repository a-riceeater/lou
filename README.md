# Lou - A Life Operations Utility

A personal, multi-device AI assistant: a central server (the brain) and a native Windows client (the hands and the face). Press <kbd>Alt</kbd>+<kbd>Space</kbd>, ask for something, review what Lou proposes, and approve it. Nothing consequential happens without your approval.

> “Reply to the latest email from Sarah and tell her I'll be there around 6.”
>
> Lou searches Gmail, reads the thread, drafts the reply, and shows it in an editable popup. You tweak it and press **Send**. The server sends exactly what you approved, and the run shows up in History with its full audit trail.

The design documents are authoritative: [ARCHITECTURE.md](ARCHITECTURE.md), [AGENT_SYSTEM.md](AGENT_SYSTEM.md), [DESKTOP_CLIENT.md](DESKTOP_CLIENT.md), [DESIGN.md](DESIGN.md), [SECURITY.md](SECURITY.md).

## What's here

```text
apps/
  server/            Node.js + TypeScript server: Fastify, WebSocket, SQLite (Drizzle), agent runtime wiring
  windows/
    src/Lou.Agent/   C# device agent library: protocol, DPAPI credentials, signed commands, device tools, UI Automation
    src/Lou.App/     WinUI 3 host: tray, global shortcut, palette + main windows, WebView2 bridge, notifications
    tests/           xUnit tests for the device agent
    frontend/        React + TypeScript + Vite UI rendered in WebView2
packages/
  shared/            errors, IDs, canonical JSON, untrusted-content envelopes, BM25
  protocol/          zod schemas for HTTP, WebSocket and the WebView2 bridge (mirrored in C#)
  tools/             ToolRegistry, ToolPolicyEngine, ToolExecutor, device tool catalog
  skills/            SKILL.md parser, safety validator, loader
  agent/             provider-neutral AgentRuntime, CustomLunaRuntime, OpenAI provider, model tasks
skills/              built-in portable SKILL.md files
deploy/              systemd unit, production env example, MCP config example
docs/                development, deployment, protocol, integrations, skills
scripts/             icon generator, live Windows end-to-end check
```

## Quick start (Ubuntu server)

Use an Ubuntu 22.04, 24.04 or 26.04 server with systemd, sudo access, Git and Python 3. On a minimal image, install the prerequisites with `sudo apt-get update && sudo apt-get install -y git python3`.

```bash
git clone https://github.com/a-riceeater/lou.git
cd lou
sudo ./deploy/setup.sh
```

Follow the prompts for your public HTTPS URL, name/timezone, master encryption key, and model provider: **OpenAI API** (API key) or **Codex CLI** (sign in as the `lou` service user). Gmail, Instagram, Spotify and MCP configuration are optional. Setup installs the required dependencies, builds Lou in `/opt/lou`, writes protected configuration to `/etc/lou/lou.env`, and enables the systemd service. Back up that configuration and `/var/lib/lou`, including the master key.

Configure your HTTPS reverse proxy or tunnel to forward to `127.0.0.1:8787`, including WebSocket upgrades on `/ws`. The installer leaves DNS, TLS and firewall configuration to you; an external health warning can mean this step is still pending.

Check Lou and generate a pairing code:

```bash
sudo systemctl status lou
curl http://127.0.0.1:8787/health
sudo -u lou -H python3 /opt/lou/deploy/setup-support.py cli pair
```

Enter your public HTTPS URL and the code in the Windows client (build/run instructions below). Pairing codes expire after 10 minutes. View logs with `sudo journalctl -u lou -f`.

To control Spotify, run `sudo ./deploy/setup-spotify.sh` (or use **Accounts → Spotify → Set up** in the Windows app), then connect your account. See [Spotify setup](docs/INTEGRATIONS.md#spotify-web-api--spotify-connect).

For updates, rerun `sudo ./deploy/setup.sh` from an updated checkout; it preserves `/var/lib/lou` and offers to keep your configuration. See [deployment instructions](docs/DEPLOYMENT.md) for HTTPS examples, backups, recovery and the manual installation fallback. Use `./deploy/setup.sh --help` for installer options.

## Quick start (development)

Requirements: Node.js 22.12+ (24 recommended), and for the Windows client the .NET 10 SDK and the WebView2 runtime (preinstalled on Windows 11).

```bash
npm install
cp .env.example apps/server/.env        # add OPENAI_API_KEY and Google OAuth credentials
npm run dev                             # server on http://127.0.0.1:8787
npm run cli -w @lou/server -- pair      # prints a one-time pairing code
```

Windows client:

```powershell
cd apps/windows
dotnet build src/Lou.App/Lou.App.csproj -p:Platform=x64   # also builds the React UI the first time
.\src\Lou.App\bin\x64\Debug\net10.0-windows10.0.19041.0\win-x64\Lou.exe
```

Enter the server address and pairing code, add Gmail under **Accounts**, then press <kbd>Alt</kbd>+<kbd>Space</kbd>.

Full development details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Tests

```bash
npm test                                              # packages, server (mocked Google APIs), UI (jsdom)
npm run typecheck
dotnet test --project apps/windows/tests/Lou.Agent.Tests/Lou.Agent.Tests.csproj
npx tsx scripts/e2e-windows.ts                        # live: real Lou.exe ↔ in-process server
npx tsx scripts/e2e-codex.ts                          # live: real Codex CLI provider (uses your codex login)
npx tsx scripts/e2e-windows-codex.ts                  # live: Windows palette → Codex, driven via WebView2 DevTools
LOU_SPOTIFY_E2E=1 npx tsx --env-file=apps/server/.env scripts/e2e-spotify.ts   # live, opt-in: your connected Spotify account
```

## Status

| Area | State |
| --- | --- |
| Gmail vertical slice (search → read → draft → editable approval → exact send → history/audit) | Implemented, tested end to end against mocked Google APIs |
| Agent runtime, tool policy, approvals, prompt-injection boundaries | Implemented and tested |
| Windows host (tray, Alt+Space, palette, main window, WebView2 bridge, DPAPI, signed commands) | Implemented; live agent ↔ server check passes |
| Skills, memory, improvement proposals, workflows, event pipeline | Implemented and tested |
| Instagram (OAuth, webhooks, reply approval) | Implemented; needs a Meta app to exercise live |
| Spotify (OAuth, playback/device control by voice or text, Now Playing remote) | Implemented, tested against a mocked Spotify API; needs a Spotify developer app and Premium to use live |
| MCP / Zapier MCP | Implemented (config-driven); needs a live MCP server to exercise |
| Model providers: OpenAI API or Codex CLI (your ChatGPT/Codex login via `codex app-server`) | Implemented; switchable in Settings; live-tested end to end with the real Codex CLI |
| Sandboxed generated helper code | Architected only (see SECURITY.md §10); not enabled |

The default model is GPT-6 Luna (`LOU_MODEL=gpt-6-luna`). Change the model ID in configuration if your account names it differently. To use your existing Codex/ChatGPT login instead of an API key, see [docs/MODEL_PROVIDERS.md](docs/MODEL_PROVIDERS.md).
