# Integrations

Preferred order (ARCHITECTURE.md §4.1): direct official API → official MCP → Zapier MCP → browser automation → desktop UI automation. Every integration is surfaced as ordinary tools in the ToolRegistry, so the runtime and policy engine treat them uniformly. OAuth tokens are encrypted at rest (AES-256-GCM, `LOU_MASTER_KEY`) and never reach the model, logs, or clients.

## Gmail (direct API)

**Setup:** Google Cloud project → enable Gmail API → OAuth consent screen (add scopes `openid email profile gmail.readonly gmail.compose`) → OAuth client of type **Web application** with redirect URI `${LOU_PUBLIC_URL}/oauth/google/callback`. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. While the consent screen is in "Testing", add your Google accounts as test users.

**Connect:** Accounts → Add Gmail (opens your browser; PKCE + single-use state). Connect as many accounts as you like. Each gets its own account ID, status, and encrypted tokens. Access tokens refresh automatically. A revoked or expired refresh token marks the account **Needs you to sign in again** and the agent reports it in plain language.

| Tool | Risk | Notes |
| --- | --- | --- |
| `gmail.search` | read | Gmail query syntax, newest first, max 10. Output is untrusted. |
| `gmail.read_thread` | read | Last 6 messages, quoted history stripped, 6 000 chars/message. Untrusted. |
| `gmail.draft_reply` | write | Saves a Gmail draft (never sends). |
| `gmail.reply` | write, **approval** | Recipients, subject, threading headers are derived by the server from the original message (the model can't set them). Body is editable in the approval. |
| `gmail.send` | write, **approval** | New email; subject and body editable. |

When several accounts are connected, tools take `accountId` (the context lists account IDs and addresses).

**Monitoring:** a poller reads `users.history` every `LOU_GMAIL_POLL_SECONDS` (default 120) and feeds new inbox messages into the event pipeline. This needs no public endpoint. Promotions, social, and forum categories are ignored deterministically. Bulk and no-reply mail is logged. Your notification rules apply next, then Luna classifies the rest. Pub/Sub push (`users.watch`) can replace polling later without changing the pipeline.

## Instagram (official API, professional accounts)

**Setup:** Meta developer app → add **Instagram** product (API setup with Instagram Login). Set:

- OAuth redirect URI: `${LOU_PUBLIC_URL}/oauth/instagram/callback`
- Webhook callback: `${LOU_PUBLIC_URL}/webhooks/instagram`, verify token = `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, subscribe to `messages`
- Env: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`

Scopes: `instagram_business_basic`, `instagram_business_manage_messages`. Long-lived tokens (60 days) are refreshed automatically.

Webhook deliveries are verified with `X-Hub-Signature-256` (HMAC with the app secret), de-duplicated by message ID, normalized into `instagram.message` events marked **external-untrusted**, and sent through the same event pipeline. Echoes and reactions are ignored.

| Tool | Risk | Notes |
| --- | --- | --- |
| `instagram.list_conversations` | read | Untrusted output |
| `instagram.read_conversation` | read | Untrusted output |
| `instagram.reply` | write, **approval** | Editable text. Meta only allows replies within 24 h of the person's last message. |

Nothing is ever sent automatically.

## Spotify (Web API + Spotify Connect)

Lou is a remote control for Spotify. It never plays audio itself. It calls the official Spotify Web API (`https://api.spotify.com/v1`) to control whatever Spotify Connect device you're using: your phone, the desktop app, the web player, speakers, TVs or consoles. There is no browser automation, simulated media keys or desktop UI automation.

### 1. Create the Spotify app

1. Sign in at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and choose **Create app**.
2. Give it any name and description (e.g. "Lou"). Add the **Redirect URI** from step 2.
3. Under *Which API/SDKs are you planning to use?*, select **Web API**. Lou needs nothing else.
4. Save, then open **Settings → Basic Information** for the **Client ID** and **Client secret** (*View client secret*).
5. Under **User Management**, add the name and email of each Spotify account that will connect, including your own.

### 2. Redirect URI

Register exactly `${LOU_PUBLIC_URL}/oauth/spotify/callback`, e.g. `https://lou.example.com/oauth/spotify/callback`. Scheme, host, port and path must match, with no trailing slash. The setup dialog and setup script both display the exact value with a copy option.

Spotify requires HTTPS, except for loopback IP literals, and it rejects `localhost`. In development Lou therefore uses `http://127.0.0.1:8787/oauth/spotify/callback` even though `LOU_PUBLIC_URL` is `http://localhost:8787`. Open the auth link on the same machine as the dev server. To serve the callback from a different public address, set `SPOTIFY_REDIRECT_URI`. It must end in `/oauth/spotify/callback` and reach Lou's server.

### 3. Give Lou the app credentials

Use one of these:

- **Windows app (easiest):** Accounts → Spotify → **Set up**. The dialog walks through the dashboard steps and shows the redirect URI. You paste the Client ID and secret. The server checks them with Spotify (client-credentials grant) and stores the secret encrypted (AES-256-GCM with `LOU_MASTER_KEY`). The secret is never shown again or returned to any client.
- **Server script:** `sudo ./deploy/setup-spotify.sh` on an installed server. It prints the redirect URI and verifies the credentials with Spotify. It then writes `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` to `/etc/lou/lou.env`, after a protected backup, and restarts Lou and checks its health. `--remove` undoes it. The main installer also offers this prompt.
- **Environment:** set the variables below. Values from the environment take precedence over credentials saved from the app.

| Variable | Required | Notes |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | yes* | From Basic Information. |
| `SPOTIFY_CLIENT_SECRET` | yes* | Server-side only; never sent to clients, logs or the model. |
| `SPOTIFY_REDIRECT_URI` | no | Defaults to `${LOU_PUBLIC_URL}/oauth/spotify/callback`. |

\* Not needed in the environment if you use the setup dialog.

### 4. Connect your account

Open Accounts → Spotify → **Connect Spotify**. Your browser opens Spotify's consent page. After you allow access, the browser shows "Spotify connected" and the Accounts section updates by itself, showing your Spotify name and the active device. Each Lou user has one Spotify account; connecting a different one replaces it. **Disconnect** deletes the stored tokens. **Reconnect** appears when authorization has expired or been revoked.

How authorization works: Lou's server is the trusted, confidential client, so it uses the **Authorization Code flow** with the secret held only on the server. It does not use PKCE.

- The `state` parameter is random, hashed at rest, single-use and expires after 10 minutes, which protects against CSRF.
- Tokens are encrypted at rest. Access tokens refresh automatically two minutes before expiry, and once more if Spotify answers 401. A rotated refresh token is stored.
- An `invalid_grant` (revoked or expired access) marks the account **Needs you to sign in again**, and Lou stops calling Spotify until you reconnect.
- Tokens are never logged, and never sent to the UI or the model.

### Scopes

| Scope | Why |
| --- | --- |
| `user-read-playback-state` | What's playing, devices, queue |
| `user-modify-playback-state` | Play, pause, skip, seek, volume, shuffle, repeat, queue, transfer |
| `user-read-currently-playing` | Current track |
| `playlist-read-private` | Find your own playlists ("play my Road Trip playlist", "my Discover Weekly") |

No library, history, email or follow scopes are requested.

### Premium and Development Mode

- **Playback control needs Spotify Premium** on the connected account. With a free account, reading state and searching still work, and commands answer "Controlling playback needs Spotify Premium".
- Since February 2026, apps in **Development Mode** have these limits:
  - The app owner must have Premium.
  - At most **5 users** can connect, and each must be listed under User Management.
  - New developers get one Client ID.
  - Search returns at most 10 results per type.
- Extended Quota Mode is only granted to organizations with a launched service and about 250k monthly users. Treat this integration as being for you and your household, not something you can open to unrelated Spotify users.
- Spotify-owned algorithmic playlists (Discover Weekly, Release Radar, Daily Mix) don't appear in search for new apps. Lou looks for them in *your* playlists instead (`/me/playlists`). If Lou can't find one, save or follow it in Spotify first.

### How device control works

- **Devices:** a Spotify Connect device appears while Spotify is open and signed in on it. Device IDs aren't stable, so every command that names a device first re-reads the live device list.
- **Name matching:** Lou tries an exact name ("Kitchen Speaker"), then the words of the name ("the bedroom speaker"), then the device kind ("my phone", "my computer", "the TV"), then a close spelling. If several devices match, Lou lists them and asks. Lou never sends commands to devices Spotify marks as *restricted*.
- **No active device:** if exactly one controllable device is available, Lou plays there. If there are several, Lou asks which one. If there are none, Lou explains that Spotify must be open on a phone, computer or speaker.
- **Sequencing:** playing on a specific device is a single transfer-and-play request. Dependent commands run one at a time, and relative volume and seek read the current state first.
  - A 429 response is retried after `Retry-After` when the wait is 5 s or less; otherwise it is reported.
  - Reads are retried once on network or 5xx errors. Player commands are never retried after an ambiguous failure, so a skip can't happen twice.
- **Polling:** agent tools always read fresh state. The **Now Playing** remote in the sidebar works like this:
  - It reads from a shared 3-second server cache, polls every 15 s while playing and every 45 s while idle, and stops while the window is hidden.
  - It moves the progress bar locally once a second.
  - It refreshes right after its own buttons and after Lou finishes a request.
  - It has album art, play/pause, previous/next, and an "Open in Spotify" link for attribution.

### Tools

| Tool | Risk | Notes |
| --- | --- | --- |
| `spotify.get_playback_state` | read | Track/episode, artists, album, position, device, volume, shuffle, repeat. Untrusted. |
| `spotify.play` | write | `query` in the user's words (server searches and picks the best song/artist/album/playlist), or `uri` from a previous result; optional `type`, `deviceName`/`spotifyDeviceId`. No args = resume. Untrusted (returns catalog names). |
| `spotify.pause` / `spotify.next` / `spotify.previous` | write | |
| `spotify.seek` | write | Exactly one of `position` ("1:32"), `positionMs`, `offsetSeconds` (±), `restart`. |
| `spotify.set_volume` | write | `volumePercent` or relative `change`; clamped to 0–100; refused if the device doesn't support remote volume. |
| `spotify.set_shuffle` / `spotify.set_repeat` | write | Repeat: `off`, `track` ("repeat this song"), `context` ("repeat this playlist"). |
| `spotify.add_to_queue` | write | Track or episode by `query` or `uri`. Untrusted. |
| `spotify.get_queue` | read | Current item and up to 10 upcoming. Untrusted. |
| `spotify.search` | read | Catalog + your playlists, ≤10 per type. Untrusted. Not needed before playing. |
| `spotify.list_devices` | read | ID, name, type, active, restricted, volume, volume support. |
| `spotify.transfer_playback` | write | Move playback to a device by name; `play` to ensure it starts. |

The model never supplies Spotify IDs it made up. The server resolves names to IDs taken from Spotify's own responses, and URIs are checked against Spotify's format. Writes don't need approval because playback is easily reversed. The emergency **write tools disabled** switch still blocks them.

Catalog text (track, playlist and podcast names) is third-party content, so it is marked untrusted. Within the same request, write actions after reading it require approval, the same prompt-injection boundary as email. Device names are your own labels and are not marked.

Examples: "Play Pink Pony Club" → `spotify.play {query}` (track). "Play some Laufey" → artist context. "Play Hit Me Hard and Soft" → album. "Play my Discover Weekly" → your playlist. "Turn Spotify down" → `set_volume {change: -10}`. "Go to 1:32" → `seek {position: "1:32"}`. "Restart this song" → `seek {restart: true}`. "Play this on my bedroom speaker" → `play {deviceName}`. "Switch Spotify to my computer" → `transfer_playback`.

### Data boundary

Lou sends the model only what the current request needs, as compact summaries. A skip is just `spotify.next`; no history or library is read. Queue reads are capped at 10 items and search at 10 per type. Spotify data is not stored, apart from the account's display name and ID. It is never used to train, fine-tune or build any model, as Spotify's Developer Terms require.

### Troubleshooting

| What you see | What to do |
| --- | --- |
| "No Spotify device is available" | The Spotify app is closed everywhere. Open it on your phone, computer or speaker (play something once if it still doesn't appear), then ask again. |
| "Spotify isn't playing on any device… Available devices: …" | Several devices are idle. Say which one ("play it on my phone"). |
| **INVALID_CLIENT: Invalid redirect URI** on Spotify's page | The redirect URI in the dashboard doesn't match exactly. Copy it from the setup dialog or `setup-spotify.sh`. Use `127.0.0.1`, not `localhost`, in development. |
| "Spotify needs you to sign in again" / **Reconnect** | Access was revoked (spotify.com → Account → Apps), expired, or the app's credentials changed. Choose Reconnect. |
| "Spotify permissions are missing" | You declined a permission, or the connection predates a scope. Reconnect and allow access. |
| "This Spotify account isn't on the app's user list" | Development Mode: add the account under User Management (5 users at most). |
| "Controlling playback needs Spotify Premium" | Playback control needs Premium on the connected account (and on the app owner's account in Development Mode). |
| "Spotify is rate limiting requests" | Wait the time stated. Development Mode has lower quotas; avoid scripts that hammer the API. |
| "… can't be controlled remotely" / volume refused | Spotify marks some devices (some speakers, cars, phones in power-saving modes) as restricted or without remote volume. Use the device itself. |
| "Spotify rejected the app's Client ID or Client secret" | Copy both again from Basic Information (*View client secret*). |
| "Nothing on Spotify matched …" | Rephrase or add the artist ("Espresso by Sabrina Carpenter"). |

Live check against your real account (opt-in, read-only unless `LOU_SPOTIFY_E2E_PLAYBACK=1`): `LOU_SPOTIFY_E2E=1 npx tsx --env-file=apps/server/.env scripts/e2e-spotify.ts`.

## MCP and Zapier MCP

Configure servers in a JSON file referenced by `LOU_MCP_CONFIG` (example: `deploy/mcp.example.json`). Secrets stay in the environment via `${VAR}` substitution.

```json
{
  "servers": [
    {
      "id": "zapier",
      "name": "Zapier",
      "transport": "http",
      "url": "${ZAPIER_MCP_URL}",
      "keywords": ["zapier", "slack", "notion"],
      "include": ["*"],
      "exclude": [],
      "readOnlyTools": ["*_find_*", "*_get_*"],
      "maxToolsPerRequest": 8
    }
  ]
}
```

Transports: `http` (Streamable HTTP), `sse`, `stdio` (`command`, `args`, `env`).

On startup each server is connected and its tools discovered, filtered by `include`/`exclude`, and registered as `mcp.<server>.<tool>`. Safety defaults:

- Every MCP tool is a **write that requires approval** unless you list it in `readOnlyTools`. Server-provided hints never relax this; a `destructiveHint` makes it destructive.
- All MCP output is untrusted.
- Each server is one tool family. It is offered to the model only when the request matches its keywords (or the model asks for it), and then only the `maxToolsPerRequest` most relevant tools.

Each MCP server appears under Accounts with its connection status.

## Adding a new integration

1. Write a client (`apps/server/src/integrations/<name>/`). Use `fetchJson` for structured errors.
2. Register tools with an honest `risk`, `untrustedOutput: true` for any external text, and `requiresApproval` plus `prepare()`/`editableFields` for consequential actions. Derive recipients and targets in `prepare()`, not from model input.
3. If it has OAuth, use `IntegrationManager.createOAuthState` / `consumeOAuthState` / `storeTokens` / `registerRefresher`.
4. Add keywords for its tool family in `packages/tools/src/families.ts`.
5. Normalize inbound events into `EventManager.ingest` with `trust: "external-untrusted"`.
