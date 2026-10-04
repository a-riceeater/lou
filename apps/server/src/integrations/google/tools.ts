import type { ToolRegistry } from "@lou/tools";
import { z } from "zod";
import type { FetchLike } from "../http";
import type { IntegrationManager } from "../manager";
import { GmailClient } from "./gmail";
import { buildMime, parseAddresses, replySubject, toGmailRaw } from "./mime";

const accountId = z.string().optional().describe("Account id from the connected accounts list. Omit if only one Gmail account is connected.");
const email = z.string().email().max(320);

export function gmailClientFactory(integrations: IntegrationManager, fetchImpl: FetchLike = fetch) {
  return (id: string) => new GmailClient((force) => (force ? integrations.forceRefresh(id) : integrations.accessToken(id)), fetchImpl);
}

const ReplyInput = z.object({
  accountId,
  messageId: z.string().min(1).describe("ID of the message being replied to (from gmail.search or gmail.read_thread)."),
  body: z.string().min(1).max(10_000).describe("Complete reply text, written as the user."),
  replyAll: z.boolean().optional().describe("Also reply to the other recipients. Default false."),
});

const ReplyPrepared = z.object({
  accountId: z.string(),
  messageId: z.string(),
  body: z.string().min(1).max(10_000),
  replyAll: z.boolean().optional(),
  from: z.string(),
  to: z.array(email).min(1).max(50),
  cc: z.array(email).max(50),
  subject: z.string().max(998),
  threadId: z.string(),
  inReplyTo: z.string(),
  references: z.string(),
});
type ReplyPrepared = z.infer<typeof ReplyPrepared>;

const SendInput = z.object({
  accountId,
  to: z.array(email).min(1).max(20),
  cc: z.array(email).max(20).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(20_000),
});
const SendPrepared = SendInput.extend({ accountId: z.string(), from: z.string(), cc: z.array(email).max(20) });
type SendPrepared = z.infer<typeof SendPrepared>;

function firstName(address: string | undefined): string {
  const parsed = parseAddresses(address)[0];
  if (!parsed) return "them";
  return parsed.name?.split(/\s+/)[0] ?? parsed.email.split("@")[0] ?? parsed.email;
}

/** Registers Gmail tools. All external content they return is marked untrusted. */
export function registerGmailTools(registry: ToolRegistry, integrations: IntegrationManager, fetchImpl: FetchLike = fetch): void {
  const client = gmailClientFactory(integrations, fetchImpl);

  registry.register(
    {
      id: "gmail.search",
      family: "gmail",
      title: "Searching email",
      description:
        "Search a Gmail account using Gmail query syntax (e.g. `from:sarah newer_than:14d`, `subject:invoice is:unread`). Returns the newest matches with sender, subject, date and snippet.",
      input: z.object({ accountId, query: z.string().min(1).max(300), maxResults: z.number().int().min(1).max(10).optional() }),
      risk: "read",
      executionTarget: "server",
      requiresApproval: false,
      exposure: "model",
      untrustedOutput: true,
    },
    {
      async execute(input, ctx) {
        const account = integrations.resolveAccount(ctx.userId, "google", input.accountId);
        const messages = await client(account.id).search(input.query, input.maxResults ?? 5, ctx.signal);
        return {
          accountId: account.id,
          messages: messages.map((m) => ({ id: m.id, threadId: m.threadId, from: m.from, to: m.to, subject: m.subject, date: m.date, snippet: m.snippet, unread: m.unread })),
        };
      },
    },
  );

  registry.register(
    {
      id: "gmail.read_thread",
      family: "gmail",
      title: "Reading email",
      description: "Read the messages of a Gmail thread (newest last). Quoted history is removed.",
      input: z.object({ accountId, threadId: z.string().min(1) }),
      risk: "read",
      executionTarget: "server",
      requiresApproval: false,
      exposure: "model",
      untrustedOutput: true,
    },
    {
      async execute(input, ctx) {
        const account = integrations.resolveAccount(ctx.userId, "google", input.accountId);
        const thread = await client(account.id).readThread(input.threadId, 6, ctx.signal);
        return {
          accountId: account.id,
          threadId: thread.threadId,
          subject: thread.subject,
          messages: thread.messages.map((m) => ({ id: m.id, from: m.from, to: m.to, cc: m.cc, date: m.date, body: m.body, attachments: m.attachments })),
        };
      },
    },
  );

  registry.register(
    {
      id: "gmail.draft_reply",
      family: "gmail",
      title: "Saving a draft",
      description: "Save a reply as a Gmail draft without sending it. Use only when the user asks for a draft rather than a reply.",
      input: z.object({ accountId, messageId: z.string().min(1), body: z.string().min(1).max(10_000) }),
      risk: "write",
      executionTarget: "server",
      requiresApproval: false,
      exposure: "model",
      untrustedOutput: false,
    },
    {
      async execute(input, ctx) {
        const prepared = await prepareReply(integrations, client, ctx.userId, { ...input, replyAll: false }, ctx.signal);
        const draft = await client(prepared.accountId).createDraft(toGmailRaw(buildMime(prepared)), prepared.threadId, ctx.signal);
        return { draftId: draft.id, threadId: prepared.threadId, to: prepared.to };
      },
    },
  );

  registry.register<z.infer<typeof ReplyInput>, unknown>(
    {
      id: "gmail.reply",
      family: "gmail",
      title: "Sending reply",
      description:
        "Reply to an email. Recipients, subject and threading are derived automatically from the original message. The user reviews and can edit the text before it is sent.",
      input: ReplyInput,
      preparedInput: ReplyPrepared,
      risk: "write",
      executionTarget: "server",
      requiresApproval: true,
      exposure: "model",
      untrustedOutput: false,
      editableFields: ["body"],
    },
    {
      async prepare(input, ctx) {
        const { prepared, displayName } = await prepareReplyWithName(integrations, client, ctx.userId, input, ctx.signal);
        return {
          input: prepared,
          presentation: {
            kind: "email.reply",
            title: `Reply to ${displayName}`,
            account: prepared.from,
            fields: [
              { key: "to", label: "To", value: [...prepared.to, ...prepared.cc].join(", "), kind: "recipients" },
              { key: "subject", label: "Subject", value: prepared.subject, kind: "text" },
              { key: "body", label: "Message", value: prepared.body, kind: "longtext" },
            ],
          },
        };
      },
      async execute(raw, ctx) {
        // Only approved, prepared input reaches here (policy requires approval).
        const input = ReplyPrepared.parse(raw);
        const sent = await client(input.accountId).send(toGmailRaw(buildMime(input)), input.threadId, ctx.signal);
        return { sent: true, messageId: sent.id, threadId: sent.threadId, to: input.to };
      },
    },
  );

  registry.register<z.infer<typeof SendInput>, unknown>(
    {
      id: "gmail.send",
      family: "gmail",
      title: "Sending email",
      description: "Send a new email (not a reply). The user reviews and can edit the subject and text before it is sent.",
      input: SendInput,
      preparedInput: SendPrepared,
      risk: "write",
      executionTarget: "server",
      requiresApproval: true,
      exposure: "model",
      untrustedOutput: false,
      editableFields: ["subject", "body"],
    },
    {
      async prepare(input, ctx) {
        const account = integrations.resolveAccount(ctx.userId, "google", input.accountId);
        const prepared: SendPrepared = {
          ...input,
          accountId: account.id,
          from: account.address ?? "",
          to: input.to.map((t) => t.toLowerCase()),
          cc: (input.cc ?? []).map((t) => t.toLowerCase()),
        };
        return {
          input: prepared,
          presentation: {
            kind: "email.send",
            title: `Email ${firstName(prepared.to[0])}`,
            account: prepared.from,
            fields: [
              { key: "to", label: "To", value: [...prepared.to, ...prepared.cc].join(", "), kind: "recipients" },
              { key: "subject", label: "Subject", value: prepared.subject, kind: "text" },
              { key: "body", label: "Message", value: prepared.body, kind: "longtext" },
            ],
          },
        };
      },
      async execute(raw, ctx) {
        const input = SendPrepared.parse(raw);
        const sent = await client(input.accountId).send(toGmailRaw(buildMime(input)), undefined, ctx.signal);
        return { sent: true, messageId: sent.id, threadId: sent.threadId };
      },
    },
  );
}

/** Like prepareReply, plus a friendly first name for the approval title. */
async function prepareReplyWithName(
  integrations: IntegrationManager,
  client: (id: string) => GmailClient,
  userId: string,
  input: z.infer<typeof ReplyInput>,
  signal: AbortSignal,
): Promise<{ prepared: ReplyPrepared; displayName: string }> {
  const prepared = await prepareReply(integrations, client, userId, input, signal);
  const original = await client(prepared.accountId).messageMeta(input.messageId, signal);
  const fromSelf = parseAddresses(original.from)[0]?.email === prepared.from.toLowerCase();
  return { prepared, displayName: firstName(fromSelf ? original.to : original.replyTo || original.from) };
}

/** Derives recipients, subject and threading headers deterministically from the original message. */
async function prepareReply(
  integrations: IntegrationManager,
  client: (id: string) => GmailClient,
  userId: string,
  input: z.infer<typeof ReplyInput>,
  signal: AbortSignal,
): Promise<ReplyPrepared> {
  const account = integrations.resolveAccount(userId, "google", input.accountId);
  const self = (account.address ?? "").toLowerCase();
  const original = await client(account.id).messageMeta(input.messageId, signal);
  const sender = parseAddresses(original.replyTo || original.from);
  const fromSelf = parseAddresses(original.from)[0]?.email === self;

  let to = (fromSelf ? parseAddresses(original.to) : sender).map((a) => a.email);
  let cc: string[] = [];
  if (input.replyAll) {
    const others = [...parseAddresses(original.to), ...parseAddresses(original.cc)].map((a) => a.email);
    cc = others.filter((e) => e !== self && !to.includes(e));
  }
  to = [...new Set(to.filter((e) => e !== self || fromSelf))];
  cc = [...new Set(cc)];
  if (!to.length) to = sender.map((a) => a.email);

  const references = [original.references, original.messageIdHeader].filter(Boolean).join(" ").trim();
  return {
    accountId: account.id,
    messageId: input.messageId,
    body: input.body,
    replyAll: input.replyAll ?? false,
    from: account.address ?? "",
    to,
    cc,
    subject: replySubject(original.subject || "(no subject)"),
    threadId: original.threadId,
    inReplyTo: original.messageIdHeader,
    references,
  };
}
