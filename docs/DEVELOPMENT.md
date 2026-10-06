# Development

## Prerequisites

- **Node.js 22.12+** (24 LTS recommended) and npm 10+.
- **Windows client:** Windows 10 19041+ or Windows 11, **.NET 10 SDK**, WebView2 runtime (included with Windows 11).
  The SDK can be installed per-user without admin rights:
  ```powershell
  iwr https://dot.net/v1/dotnet-install.ps1 -OutFile dotnet-install.ps1
  .\dotnet-install.ps1 -Channel 10.0 -InstallDir "$env:LOCALAPPDATA\Microsoft\dotnet"
  ```
- Optional: an OpenAI API key with access to GPT-6 Luna, a Google Cloud OAuth client for Gmail, a Meta app for Instagram, a Spotify developer app (and Premium) for Spotify.

npm 11 blocks dependency install scripts by default; the repo's `package.json` allow-lists the two that need them (`better-sqlite3`, `esbuild`).

## Server

```bash
npm install
cp .env.example apps/server/.env
npm run dev
```

`npm run dev` runs `apps/server/src/index.ts` with `tsx watch`, loading `apps/server/.env`. The SQLite database and a generated development master key live in `apps/server/data/`. Migrations run automatically on startup.

Health check: `curl http://127.0.0.1:8787/health`.

Without `OPENAI_API_KEY` everything except the agent works, and agent requests fail with a clear "model isn't configured" message, unless you use the Codex CLI provider.

### Using your Codex / ChatGPT login instead of an API key

```bash
npm install -g @openai/codex
codex login
codex --version
```

Set `AI_PROVIDER=codex_cli` in `apps/server/.env` (or pick **Codex CLI** under **Settings → Assistant model**). Lou runs `codex app-server` locked down so it can only act through Lou's own tools and approvals. Details, security model and troubleshooting: [MODEL_PROVIDERS.md](MODEL_PROVIDERS.md).

### Pairing a device

```bash
npm run cli -w @lou/server -- pair            # one-time code, valid 10 minutes
npm run cli -w @lou/server -- devices         # list devices
npm run cli -w @lou/server -- revoke <id>     # revoke a device credential
npm run cli -w @lou/server -- audit 50        # recent audit entries
npm run cli -w @lou/server -- controls agentPaused=true   # emergency controls
```

A signed-in device can also create codes from **Devices → Add a device**.

### Gmail in development

1. Google Cloud Console → APIs & Services → enable the **Gmail API**.
2. OAuth consent screen: External, add yourself as a test user, add scopes `gmail.readonly` and `gmail.compose`.
3. Credentials → OAuth client ID → **Web application**, with redirect URI `http://localhost:8787/oauth/google/callback`.
4. In `apps/server/.env` set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `LOU_PUBLIC_URL=http://localhost:8787`.
5. In the app: **Accounts → Add Gmail**. Repeat for more accounts.

### Database migrations

The schema lives in `apps/server/src/db/schema.ts`. After changing it:

```bash
npm run db:generate -w @lou/server -- --name describe_change
```

Commit the generated SQL in `apps/server/drizzle/`.

## Windows client

```powershell
cd apps\windows
dotnet build src\Lou.App\Lou.App.csproj -p:Platform=x64
.\src\Lou.App\bin\x64\Debug\net10.0-windows10.0.19041.0\win-x64\Lou.exe
```

The first build runs `npm run build` in `frontend/` and copies the bundle to `wwwroot/`. After UI changes, run `npm run build -w @lou/windows-frontend` again (or delete `wwwroot/`).

Headless provisioning (useful for testing):

```powershell
Lou.exe --pair http://localhost:8787 ABCD-EFGH "My PC"
Lou.exe --unpair
```

Local files (all per-user under `%LOCALAPPDATA%\Lou`): `device.bin` (DPAPI-encrypted credential), `settings.json` (shortcut, locally disabled capabilities), `audit.log` (local device actions), `logs\`, `WebView2\`.

### UI development with hot reload

Run the UI in a browser against the dev server (uses a development bridge that talks to the server directly; set `LOU_CORS_ORIGINS=http://localhost:5173` in the server env):

```bash
npm run dev:ui      # http://localhost:5173/#/app  or  #/palette
```

Design preview with fixture data (no server needed): `cd apps/windows/frontend && npx vite --mode demo`, then open `#/palette?state=approval`, `#/palette?state=answer`, or `#/app/inbox`.

Or inside the real host with `LOU_UI_DEV_URL=http://localhost:5173` set before starting `Lou.exe` (dev tools enabled).

## Tests

| Command | Covers |
| --- | --- |
| `npm test` | Policy engine, registry, skills validator, runtime (selection, approvals, permissions, injection), server end to end with mocked Gmail/OAuth, WebSocket replay and signed commands, restart persistence, memory/skills/workflows/events/Instagram, Spotify (mocked accounts + Web API: OAuth, refresh, playback, devices, errors), UI palette, Spotify setup and Now Playing |
| `npm run typecheck` | Strict TypeScript across all packages and the UI |
| `dotnet test --project apps/windows/tests/Lou.Agent.Tests/Lou.Agent.Tests.csproj` | Command signature/expiry/replay checks, local path policy, tools, DPAPI storage, protocol shape |
| `npx tsx scripts/e2e-windows.ts` | Real `Lou.exe` paired to an in-process server, executing signed device commands |
| `npx tsx scripts/e2e-codex.ts` | Real Codex CLI (your login) through Lou: tools, approval, exact send, thread reuse and resume after restart (fake Gmail) |
| `npx tsx scripts/e2e-windows-codex.ts` | Real `Lou.exe` palette driven through WebView2 DevTools with the real Codex CLI: streaming, approval editing, Send |

## Conventions

- Strict TypeScript, zod validation at every boundary, structured `LouError` codes.
- Protocol shapes live once in `packages/protocol`; the C# mirror is `Lou.Agent/Protocol/Messages.cs`.
- Commits follow Conventional Commits (see `AGENTS.md`).
