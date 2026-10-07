import { z } from "zod";

const identifier = z.string().min(1).max(200);
const text = z.string().max(20_000);
export const ScriptMessage = z.object({
  id: identifier, threadId: identifier, from: text, to: text, cc: text, replyTo: text,
  subject: text, date: z.string().max(100), messageIdHeader: text, references: text,
  snippet: z.string().max(1000), labelIds: z.array(z.string().max(200)).max(100),
  unread: z.boolean(), bulk: z.boolean(), body: z.string().max(6000),
  attachments: z.array(z.string().max(500)).max(100),
  attachmentMetadata: z.array(z.object({ index: z.number().int().min(0), filename: z.string().max(500), mimeType: z.string().max(200), size: z.number().int().min(0) })).max(100),
});
const outgoing = z.object({
  to: z.array(z.string().email()).min(1).max(50), cc: z.array(z.string().email()).max(50).optional(), bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(998), body: text, htmlBody: z.string().max(100_000).optional(),
  messageId: identifier.optional(), replyAll: z.boolean().optional(),
  attachments: z.array(z.object({ filename: z.string().max(500), mimeType: z.string().max(200), data: z.string().max(500_000) })).max(5).optional(),
});
export const CommandInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("SEARCH"), query: z.string().max(1000), limit: z.number().int().min(1).max(50), offset: z.number().int().min(0).max(10_000).default(0) }),
  z.object({ operation: z.literal("MESSAGE"), messageId: identifier }),
  z.object({ operation: z.literal("THREAD"), threadId: identifier, limit: z.number().int().min(1).max(20) }),
  z.object({ operation: z.literal("SEND"), email: outgoing }),
  z.object({ operation: z.literal("DRAFT"), email: outgoing }),
  z.object({ operation: z.literal("UPDATE_DRAFT"), draftId: identifier, email: outgoing }),
  z.object({ operation: z.literal("DRAFT_MESSAGE"), draftId: identifier }),
  z.object({ operation: z.literal("SEND_DRAFT"), draftId: identifier, fingerprint: z.string().length(64).optional() }),
  z.object({ operation: z.literal("FORWARD"), messageId: identifier, email: outgoing }),
  z.object({ operation: z.literal("MODIFY"), threadId: identifier, action: z.enum(["read", "unread", "archive", "inbox", "star", "unstar", "trash", "addLabel", "removeLabel"]), label: z.string().min(1).max(200).optional() }),
  z.object({ operation: z.literal("ATTACHMENT"), messageId: identifier, index: z.number().int().min(0).max(99) }),
  z.object({ operation: z.literal("PROFILE") }),
]);
export type ScriptCommandInput = z.infer<typeof CommandInput>;
export function resultSchema(operation: string) {
  const sent = z.object({ id: identifier, threadId: identifier });
  switch (operation) {
    case "SEARCH": return z.array(ScriptMessage).max(50);
    case "MESSAGE": return ScriptMessage;
    case "THREAD": return z.object({ threadId: identifier, subject: text, messages: z.array(ScriptMessage).max(20) });
    case "SEND": case "SEND_DRAFT": case "FORWARD": return sent;
    case "DRAFT": case "UPDATE_DRAFT": return z.object({ id: identifier, message: sent });
    case "DRAFT_MESSAGE": return z.object({ id: identifier, message: ScriptMessage, fingerprint: z.string().length(64) });
    case "ATTACHMENT": return z.object({ filename: z.string().max(500), mimeType: z.string().max(200), data: z.string().max(700_000) });
    case "PROFILE": return z.object({ emailAddress: z.string().email().or(z.literal("")), historyId: z.string() });
    default: return z.object({ ok: z.literal(true) });
  }
}
