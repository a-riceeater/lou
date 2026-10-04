# Lou

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

Full details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Production on Ubuntu with systemd: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests

```bash
npm test                                              # packages, server (mocked Google APIs), UI (jsdom)
npm run typecheck
dotnet test --project apps/windows/tests/Lou.Agent.Tests/Lou.Agent.Tests.csproj
npx tsx scripts/e2e-windows.ts                        # live: real Lou.exe ↔ in-process server
```

## Status

| Area | State |
| --- | --- |
| Gmail vertical slice (search → read → draft → editable approval → exact send → history/audit) | Implemented, tested end to end against mocked Google APIs |
| Agent runtime, tool policy, approvals, prompt-injection boundaries | Implemented and tested |
| Windows host (tray, Alt+Space, palette, main window, WebView2 bridge, DPAPI, signed commands) | Implemented; live agent ↔ server check passes |
| Skills, memory, improvement proposals, workflows, event pipeline | Implemented and tested |
| Instagram (OAuth, webhooks, reply approval) | Implemented; needs a Meta app to exercise live |
| MCP / Zapier MCP | Implemented (config-driven); needs a live MCP server to exercise |
| Sandboxed generated helper code | Architected only (see SECURITY.md §10); not enabled |

The default model is GPT-6 Luna (`LOU_MODEL=gpt-6-luna`). Change the model ID in configuration if your account names it differently.
