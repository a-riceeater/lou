import type { GmailAppsScript } from "./appscript";
import { GmailClient, type MessageMeta, type ThreadMessage } from "./gmail";
import { buildMime, toGmailRaw, type OutgoingEmail } from "./mime";
import type { ScriptCommandInput } from "./script-protocol";

export interface GmailProvider {
  profile(signal?: AbortSignal): Promise<{ emailAddress: string; historyId: string }>;
  search(query: string, limit: number, signal?: AbortSignal): Promise<MessageMeta[]>;
  messageMeta(id: string, signal?: AbortSignal): Promise<MessageMeta>;
  readThread(id: string, limit: number, signal?: AbortSignal): Promise<{ threadId: string; subject: string; messages: ThreadMessage[] }>;
  sendEmail(email: OutgoingEmail, threadId?: string, signal?: AbortSignal): Promise<{ id: string; threadId: string }>;
  draftEmail(email: OutgoingEmail, threadId?: string, signal?: AbortSignal): Promise<{ id: string; message: { id: string; threadId: string } }>;
  command(input: ScriptCommandInput, signal?: AbortSignal): Promise<unknown>;
}

export class GmailOAuthProvider extends GmailClient implements GmailProvider {
  sendEmail(email: OutgoingEmail, threadId?: string, signal?: AbortSignal) { return this.send(toGmailRaw(buildMime(email)), threadId, signal); }
  draftEmail(email: OutgoingEmail, threadId?: string, signal?: AbortSignal) { return this.createDraft(toGmailRaw(buildMime(email)), threadId, signal); }
  async command(input: ScriptCommandInput, signal?: AbortSignal): Promise<unknown> {
    switch (input.operation) {
      case "SEARCH": return this.search(input.query, input.limit, signal);
      case "MESSAGE": return this.readMessage(input.messageId, signal);
      case "THREAD": return this.readThread(input.threadId, input.limit, signal);
      case "PROFILE": return this.profile(signal);
      case "SEND": return this.sendEmail(input.email, undefined, signal);
      case "DRAFT": return this.draftEmail(input.email, undefined, signal);
      case "MODIFY": return this.modifyThread(input.threadId, input.action, input.label, signal);
      case "ATTACHMENT": return this.attachment(input.messageId, input.index, signal);
      case "SEND_DRAFT": return this.sendDraft(input.draftId, signal);
      case "UPDATE_DRAFT": return this.updateDraft(input.draftId, toGmailRaw(buildMime(input.email)), signal);
      case "FORWARD": {
        const original = await this.readMessage(input.messageId, signal);
        const attachments = await Promise.all(original.attachmentMetadata.map(a => this.attachment(input.messageId, a.index, signal)));
        return this.sendEmail({ ...input.email, subject: input.email.subject || `Fwd: ${original.subject}`, body: `${input.email.body}\n\n${original.body}`, attachments: [...(input.email.attachments ?? []), ...attachments] }, undefined, signal);
      }
    }
  }
}

export class GmailAppsScriptProvider implements GmailProvider {
  constructor(private readonly transport: GmailAppsScript, private readonly accountId: string) {}
  command(input: ScriptCommandInput, signal?: AbortSignal): Promise<unknown> { return this.transport.execute(this.accountId, input, signal); }
  profile(signal?: AbortSignal) { return this.transport.execute<{ emailAddress: string; historyId: string }>(this.accountId, { operation: "PROFILE" }, signal); }
  search(query: string, limit: number, signal?: AbortSignal) { return this.transport.execute<MessageMeta[]>(this.accountId, { operation: "SEARCH", query, limit, offset: 0 }, signal); }
  messageMeta(messageId: string, signal?: AbortSignal) { return this.transport.execute<MessageMeta>(this.accountId, { operation: "MESSAGE", messageId }, signal); }
  readThread(threadId: string, limit: number, signal?: AbortSignal) { return this.transport.execute<{ threadId: string; subject: string; messages: ThreadMessage[] }>(this.accountId, { operation: "THREAD", threadId, limit }, signal); }
  sendEmail(email: OutgoingEmail, _threadId?: string, signal?: AbortSignal) { return this.transport.execute<{ id: string; threadId: string }>(this.accountId, { operation: "SEND", email }, signal); }
  draftEmail(email: OutgoingEmail, _threadId?: string, signal?: AbortSignal) { return this.transport.execute<{ id: string; message: { id: string; threadId: string } }>(this.accountId, { operation: "DRAFT", email }, signal); }
}
