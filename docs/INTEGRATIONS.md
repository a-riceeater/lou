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
