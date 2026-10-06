# Protocol

The source of truth is `packages/protocol` (zod). The C# mirror is `apps/windows/src/Lou.Agent/Protocol/Messages.cs`. Protocol version: **1**.

## Transport and authentication

| Channel | Use |
| --- | --- |
| HTTPS `/api/*` | Ordinary requests (runs, approvals, accounts, skills, memory, settings, audit) |
| WSS `/ws` | Persistent device session: live progress, approvals, notifications, device commands |
| HTTPS `/oauth/*`, `/webhooks/*` | OAuth callbacks (state + PKCE), signed provider webhooks |

Every device has its own identity: `deviceId`, a bearer **device token** (stored server-side only as SHA-256), and a **command key** (stored server-side encrypted) used to sign device commands. Revoking a device invalidates its token immediately and closes its socket with code `4001`.

- HTTP: `Authorization: Bearer lou_dev_…`
- WebSocket: same header, or (browsers) subprotocols `lou.v1, bearer.<token>`.

### Pairing

```
POST /api/devices/register
{ "pairingCode": "ABCD-EFGH", "name": "My PC", "platform": "windows", "clientVersion": "0.1.0", "capabilities": ["open_app", …] }
→ 201 { "deviceId", "deviceToken", "commandKey", "userId" }
```

Codes are single-use, expire after 10 minutes, and are rate limited. Token and key are returned exactly once; the Windows client stores them with DPAPI.

## WebSocket frames

```jsonc
{ "v": 1, "id": "msg_…", "type": "…", "ts": "ISO-8601", "payload": { … }, "seq": 123, "runId": "run_…", "replyTo": "…" }
```

### Client → server

| type | payload |
| --- | --- |
| `device.hello` | `{ platform, clientVersion, capabilities[], lastSeq? }` (must be the first frame, within 10 s) |
| `device.heartbeat` | `{}` every 20 s |
| `device.command.result` | `{ commandId, success, result?, error? }` |
| `ping` | `{}` → `pong` |

### Server → client

| type | payload |
| --- | --- |
| `session.ready` | `{ sessionId, deviceId, protocolVersion, serverTime, currentSeq, resyncRequired }` |
| `agent.progress` | `{ runId, status, label? }` (label is user-facing, e.g. "Searching email") |
| `agent.delta` | `{ runId, text }` streamed assistant text (not replayed; the final message arrives in `agent.completed`) |
| `agent.completed` | `{ runId, status, message, error }`. A failed run may carry `error.details.fallbackProvider`, an explicit retry offer |
| `approval.requested` | `{ approval: ApprovalView }` |
| `approval.resolved` | `{ approvalId, status: approved \| rejected \| expired \| executed \| failed, runId }` |
| `notification.created` | `{ notification: NotificationView }` |
| `device.command` | `{ commandId, body, signature }` (see below) |
| `device.revoked` | `{}`, then close `4001` |
| `error` | `{ code, message }` |

### Reconnect and replay

UI-relevant frames carry a monotonically increasing `seq` (seeded from server boot time, so it keeps increasing across restarts). The client sends its last processed `seq` in `device.hello`; the server replays newer buffered frames. If the gap can't be covered, `session.ready.resyncRequired` is `true` and the client refetches state over HTTPS (e.g. `GET /api/approvals?status=pending`). Clients reconnect with jittered exponential backoff (1 s → 30 s).

### Signed device commands

```jsonc
// payload of "device.command"
{ "commandId": "cmd_…", "body": "<JSON string>", "signature": "base64(HMAC-SHA256(commandKey, utf8(body)))" }
// body
{ "commandId", "deviceId", "toolId": "device.search_files", "input": { … }, "issuedAt", "expiresAt", "approvalId": "apr_…" | null }
```

The signature covers the exact transmitted string, so no cross-language canonicalization is needed. The device rejects commands that are unsigned, tampered, for another device, expired (60 s TTL), from the future (>2 min skew), or replayed. It then applies **local policy** (personal folders only, no executables, protected processes such as password managers, locally disabled capabilities, local confirmation for high-risk commands) before executing.

## HTTP API (device-authenticated)

| Method & path | Purpose |
| --- | --- |
| `GET /api/me` | Identity, server version, model |
| `POST /api/runs` `{ text, conversationId?, inputMode, provider? }` | Start a run → `202 { runId, conversationId }`. `provider` is a one-off, audited override |
| `GET /api/runs/:id` | `RunView` with user-facing steps |
| `POST /api/runs/:id/cancel` | Cancel (expires its pending approval) |
| `GET /api/history` | Recent runs with outcome |
| `GET /api/approvals?status=pending` · `GET /api/approvals/:id` | Approvals |
| `POST /api/approvals/:id/resolve` `{ decision, actionHash, edits? }` | Approve (optionally with edits to editable fields) or reject |
| `GET /api/accounts` · `POST /api/accounts/{google,instagram,spotify}/connect` · `POST /api/accounts/:id/check` · `DELETE /api/accounts/:id` | Accounts |
| `GET /api/google` · `POST /api/google/app` `{ clientId, clientSecret }` · `DELETE /api/google/app` | Gmail setup status (`configSource`: `env` · `server` · `null`, client ID, redirect URI, scopes) and the Google OAuth client from the setup dialog (verified with Google, secret stored encrypted, never returned) |
| `GET /api/spotify` · `POST /api/spotify/app` `{ clientId, clientSecret }` · `DELETE /api/spotify/app` | Spotify status (`not_configured` · `disconnected` · `connected` · `needs_reauth` · `unavailable`, redirect URI, account) and app credentials from the setup dialog (verified with Spotify, secret stored encrypted, never returned) |
| `GET /api/spotify/player` · `POST /api/spotify/player` `{ action, volumePercent? }` (action: `play` · `pause` · `next` · `previous` · `volume`) | Now Playing remote: cached player view (3 s) and direct controls |
| `GET /api/devices` · `POST /api/devices/pairing-codes` · `POST /api/devices/:id/revoke` | Devices |
| `GET /api/skills` · `GET /api/skills/:id` · `POST /api/skills` · `POST /api/skills/:id/enable` · `POST /api/skills/:id/rollback` · `POST /api/skills/versions/:id/activate` | Skills |
| `GET/POST /api/memories` · `PATCH/DELETE /api/memories/:id` | Memory |
| `GET /api/proposals` · `POST /api/proposals/:id/resolve` | Self-improvement proposals |
| `GET /api/workflows` | Workflows |
| `GET /api/notifications` · `POST /api/notifications/:id/{read,dismiss}` | Attention feed |
| `GET /api/audit?runId=` | Audit log |
| `GET/PATCH /api/settings` | Emergency controls and `aiProvider` (`openai_api` | `codex_cli`) |
| `GET /api/providers?probe=1` | Provider status (state, summary, hint, details such as auth type and CLI version); `probe` starts and checks Codex |
| `POST /api/transcribe` (multipart `file`) | Voice → text |

Errors: `{ "error": { "code", "message", "retryable" } }` with codes from `packages/shared/src/errors.ts` (e.g. `AUTH_REQUIRED` 424 means an account must reconnect, `APPROVAL_MISMATCH` 409, `POLICY_DENIED` 403).

### Approval integrity

`ApprovalView.actionHash` is the SHA-256 of the canonical JSON of the immutable proposed action. To resolve, the client echoes the hash it displayed and sends values only for `editable` fields. The server rejects stale hashes, edits to non-editable fields (e.g. recipients), and second resolutions. It computes the final action and its hash, and the executor runs only a call whose input hash matches the approved final hash.

## WebView2 bridge (React ↔ C#)

```jsonc
{ "type": "native.request", "requestId": "req_…", "method": "api.request", "params": { "method": "GET", "path": "/api/history" } }
{ "type": "native.response", "requestId": "req_…", "success": true, "result": { "status": 200, "body": { … } } }
{ "type": "native.event", "event": "server.message", "payload": { /* WebSocket frame */ } }
```

Methods: `api.request` (only `/api/*` paths), `api.transcribe`, `app.info`, `app.openExternal` (http/https only), `window.hide|show|resize`, `pairing.complete|reset`, `clipboard.read|write`, `settings.get|set`. Events: `server.message`, `connection.state`, `window.shown`, `palette.prefill`.

The React UI never holds the device credential. The host accepts messages only from its own origin (`https://app.lou.local`), blocks navigation elsewhere and new windows, and grants the microphone only to the app origin. Device commands are never forwarded to the UI.
