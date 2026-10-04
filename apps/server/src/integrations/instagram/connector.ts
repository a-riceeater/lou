import { LouError } from "@lou/shared";
import type { ToolRegistry } from "@lou/tools";
import { z } from "zod";
import type { AuditLog } from "../../core/audit";
import type { EventManager } from "../../events/manager";
import type { Logger } from "../../logger";
import type { FetchLike } from "../http";
import type { IntegrationManager } from "../manager";
import { InstagramClient, InstagramOAuth } from "./client";

const WebhookSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().optional(),
      messaging: z
        .array(
          z.object({
            sender: z.object({ id: z.string() }),
            recipient: z.object({ id: z.string() }),
            timestamp: z.number(),
            message: z.object({ mid: z.string(), text: z.string().optional(), is_echo: z.boolean().optional() }).passthrough().optional(),
            reaction: z.unknown().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

/**
 * Instagram professional account integration via the official API: OAuth,
 * message webhooks, conversation reads, and approval-gated replies. Incoming
 * messages are untrusted external content.
 */
export class InstagramConnector {
  private readonly oauth: InstagramOAuth | undefined;

  constructor(
    private readonly options: { appId?: string; appSecret?: string; verifyToken?: string; publicUrl: string },
    private readonly integrations: IntegrationManager,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (options.appId && options.appSecret) {
      this.oauth = new InstagramOAuth(options.appId, options.appSecret, `${options.publicUrl}/oauth/instagram/callback`, fetchImpl);
      integrations.registerRefresher("instagram", (_refresh, accessToken) => this.oauth!.refresh(accessToken));
    }
  }

  get configured(): boolean {
    return !!this.oauth;
  }

  client(accountId: string): InstagramClient {
    return new InstagramClient(() => this.integrations.accessToken(accountId), this.fetchImpl);
  }

  startConnect(userId: string): { authUrl: string } {
    if (!this.oauth) throw new LouError("NOT_CONFIGURED", "Instagram isn't set up on the server yet (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET).");
    const { state } = this.integrations.createOAuthState(userId, "instagram", false);
    return { authUrl: this.oauth.authUrl(state) };
  }

  async handleCallback(query: { code?: string; state?: string; error?: string; error_reason?: string }): Promise<{ accountId: string; username: string }> {
    if (!this.oauth) throw new LouError("NOT_CONFIGURED", "Instagram isn't configured on this server.");
    const { userId } = this.integrations.consumeOAuthState(query.state, "instagram");
    if (query.error || !query.code) throw new LouError("UNAUTHORIZED", query.error_reason === "user_denied" ? "Access was not granted." : "Instagram sign-in failed.");
    const token = await this.oauth.exchangeCode(query.code.replace(/#_$/, ""));
    const me = await new InstagramClient(async () => token.accessToken, this.fetchImpl).me();
    const accountId = this.integrations.upsertAccount({
      userId,
      provider: "instagram",
      externalId: String(me.user_id),
      displayName: me.name ?? me.username,
      address: `@${me.username}`,
      capabilities: ["conversations", "messages", "reply"],
    });
    this.integrations.storeTokens(accountId, "instagram", {
      accessToken: token.accessToken,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null,
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"],
    });
    this.audit.record({ userId, actorType: "user", actorId: userId, action: "account.connected", targetType: "account", targetId: accountId, details: { provider: "instagram", username: me.username } });
    return { accountId, username: me.username };
  }

  verifyWebhookChallenge(query: Record<string, string | undefined>): string {
    if (query["hub.mode"] !== "subscribe" || !this.options.verifyToken || query["hub.verify_token"] !== this.options.verifyToken) {
      throw new LouError("FORBIDDEN", "Webhook verification failed.");
    }
    return query["hub.challenge"] ?? "";
  }

  /** Verifies and normalizes a webhook delivery into untrusted events. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined, events: EventManager): Promise<number> {
    if (!this.oauth?.verifySignature(rawBody, signature)) throw new LouError("UNAUTHORIZED", "Invalid webhook signature.");
    const parsed = WebhookSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
    if (!parsed.success || parsed.data.object !== "instagram") return 0;
    let count = 0;
    for (const entry of parsed.data.entry) {
      const account = this.integrations.findByExternalId("instagram", entry.id);
      if (!account || account.status === "disconnected") continue;
      for (const m of entry.messaging ?? []) {
        if (!m.message || m.message.is_echo || m.sender.id === entry.id) continue;
        const profile = await this.client(account.id).userProfile(m.sender.id);
        const result = await events.ingest({
          userId: account.userId,
          source: "instagram",
          accountId: account.id,
          type: "instagram.message",
          externalId: `instagram:${m.message.mid}`,
          trust: "external-untrusted",
          occurredAt: new Date(m.timestamp).toISOString(),
          payload: { senderId: m.sender.id, senderUsername: profile.username ?? null, text: (m.message.text ?? "").slice(0, 4000), isReaction: !!m.reaction },
        });
        if (result) count++;
      }
    }
    this.logger.info({ count }, "instagram webhook processed");
    return count;
  }

  registerTools(registry: ToolRegistry): void {
    const accountId = z.string().optional().describe("Instagram account id. Omit if only one is connected.");

    registry.register(
      {
        id: "instagram.list_conversations",
        family: "instagram",
        title: "Checking Instagram",
        description: "List recent Instagram DM conversations with participants and the latest message.",
        input: z.object({ accountId, limit: z.number().int().min(1).max(20).optional() }),
        risk: "read",
        executionTarget: "server",
        requiresApproval: false,
        exposure: "model",
        untrustedOutput: true,
      },
      {
        execute: async (input, ctx) => {
          const account = this.integrations.resolveAccount(ctx.userId, "instagram", input.accountId);
          return { accountId: account.id, conversations: await this.client(account.id).conversations(input.limit ?? 10) };
        },
      },
    );

    registry.register(
      {
        id: "instagram.read_conversation",
        family: "instagram",
        title: "Reading messages",
        description: "Read recent messages in an Instagram DM conversation (oldest first).",
        input: z.object({ accountId, conversationId: z.string().min(1), limit: z.number().int().min(1).max(30).optional() }),
        risk: "read",
        executionTarget: "server",
        requiresApproval: false,
        exposure: "model",
        untrustedOutput: true,
      },
      {
        execute: async (input, ctx) => {
          const account = this.integrations.resolveAccount(ctx.userId, "instagram", input.accountId);
          return { accountId: account.id, messages: await this.client(account.id).messages(input.conversationId, input.limit ?? 10) };
        },
      },
    );

    const ReplyInput = z.object({ accountId, recipientId: z.string().min(1).describe("Instagram-scoped user ID of the person to reply to."), text: z.string().min(1).max(1000) });
    const ReplyPrepared = ReplyInput.extend({ accountId: z.string(), igUserId: z.string(), recipientLabel: z.string() });

    registry.register<z.infer<typeof ReplyInput>, unknown>(
      {
        id: "instagram.reply",
        family: "instagram",
        title: "Sending Instagram reply",
        description: "Reply to an Instagram DM. The user reviews and can edit the text before it is sent. Only possible within 24 hours of their last message.",
        input: ReplyInput,
        preparedInput: ReplyPrepared,
        risk: "write",
        executionTarget: "server",
        requiresApproval: true,
        exposure: "model",
        untrustedOutput: false,
        editableFields: ["text"],
      },
      {
        prepare: async (input, ctx) => {
          const account = this.integrations.resolveAccount(ctx.userId, "instagram", input.accountId);
          const profile = await this.client(account.id).userProfile(input.recipientId);
          const label = profile.username ? `@${profile.username}` : (profile.name ?? input.recipientId);
          const prepared = { ...input, accountId: account.id, igUserId: account.externalId ?? "", recipientLabel: label };
          return {
            input: prepared,
            presentation: {
              kind: "message.reply",
              title: `Reply to ${label}`,
              account: account.address ?? undefined,
              fields: [
                { key: "recipientLabel", label: "To", value: label, kind: "recipients" },
                { key: "text", label: "Message", value: input.text, kind: "longtext" },
              ],
            },
          };
        },
        execute: async (raw, ctx) => {
          const input = ReplyPrepared.parse(raw);
          const account = this.integrations.resolveAccount(ctx.userId, "instagram", input.accountId);
          const res = await this.client(account.id).send(input.igUserId, input.recipientId, input.text);
          return { sent: true, messageId: res.messageId, to: input.recipientLabel };
        },
      },
    );
  }
}
