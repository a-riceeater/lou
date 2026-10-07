import { createHash } from "node:crypto";
import { LouError } from "@lou/shared";
import { fetchJson, type FetchLike } from "../http";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References", "Reply-To", "List-Unsubscribe", "Precedence", "Auto-Submitted"];
const MAX_BODY_CHARS = 6000;

export interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface MessageMeta {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  bcc?: string;
  replyTo: string;
  subject: string;
  date: string;
  messageIdHeader: string;
  references: string;
  snippet: string;
  labelIds: string[];
  unread: boolean;
  bulk: boolean;
}

export interface ThreadMessage extends MessageMeta {
  body: string;
  attachments: string[];
}

export type TokenGetter = (forceRefresh: boolean) => Promise<string>;

/** Thin Gmail REST client. OAuth tokens stay inside; callers get plain data. */
export class GmailClient {
  constructor(
    private readonly token: TokenGetter,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async profile(signal?: AbortSignal): Promise<{ emailAddress: string; historyId: string }> {
    return this.call(`${API}/profile`, {}, signal);
  }

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<MessageMeta[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    const list = await this.call<{ messages?: Array<{ id: string }> }>(`${API}/messages?${params}`, {}, signal);
    const ids = (list.messages ?? []).map((m) => m.id);
    return mapLimit(ids, 5, (id) => this.messageMeta(id, signal));
  }

  async messageMeta(id: string, signal?: AbortSignal): Promise<MessageMeta> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const h of META_HEADERS) params.append("metadataHeaders", h);
    const msg = await this.call<GmailMessageResource>(`${API}/messages/${encodeURIComponent(id)}?${params}`, {}, signal);
    return toMeta(msg);
  }

  async readThread(threadId: string, maxMessages: number, signal?: AbortSignal): Promise<{ threadId: string; subject: string; messages: ThreadMessage[] }> {
    const thread = await this.call<{ id: string; messages?: GmailMessageResource[] }>(`${API}/threads/${encodeURIComponent(threadId)}?format=full`, {}, signal);
    const messages = (thread.messages ?? []).slice(-maxMessages).map((m) => ({
      ...toMeta(m),
      body: extractBody(m.payload).slice(0, MAX_BODY_CHARS),
      attachments: collectAttachments(m.payload),
    }));
    return { threadId: thread.id, subject: messages[0]?.subject ?? "", messages };
  }

  async send(raw: string, threadId: string | undefined, signal?: AbortSignal): Promise<{ id: string; threadId: string }> {
    return this.call(`${API}/messages/send`, { json: { raw, ...(threadId ? { threadId } : {}) } }, signal);
  }

  async createDraft(raw: string, threadId: string | undefined, signal?: AbortSignal): Promise<{ id: string; message: { id: string; threadId: string } }> {
    return this.call(`${API}/drafts`, { json: { message: { raw, ...(threadId ? { threadId } : {}) } } }, signal);
  }

  async readMessage(id: string, signal?: AbortSignal) {
    const resource = await this.call<GmailMessageResource>(`${API}/messages/${encodeURIComponent(id)}?format=full`, {}, signal);
    const parts: GmailPart[] = [];
    const walk = (part?: GmailPart) => { if (!part) return; if (part.filename) parts.push(part); for (const child of part.parts ?? []) walk(child); };
    walk(resource.payload);
    return { ...toMeta(resource), body: extractBody(resource.payload).slice(0, MAX_BODY_CHARS), attachments: collectAttachments(resource.payload), attachmentMetadata: parts.map((part, index) => ({ index, filename: part.filename!, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0, attachmentId: part.body?.attachmentId })) };
  }

  async attachment(messageId: string, index: number, signal?: AbortSignal) {
    const message = await this.readMessage(messageId, signal);
    const attachment = message.attachmentMetadata[index];
    if (!attachment?.attachmentId) throw new LouError("NOT_FOUND", "Attachment not found.");
    if (attachment.size > 500_000) throw new LouError("VALIDATION_FAILED", "Attachment exceeds Lou’s 500 KB transfer limit. Open it in Gmail.");
    const content = await this.call<{ data: string }>(`${API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`, {}, signal);
    return { filename: attachment.filename, mimeType: attachment.mimeType, data: Buffer.from(content.data, "base64url").toString("base64") };
  }

  async modifyThread(threadId: string, action: string, label: string | undefined, signal?: AbortSignal) {
    const changes: Record<string, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
      read: { removeLabelIds: ["UNREAD"] }, unread: { addLabelIds: ["UNREAD"] }, archive: { removeLabelIds: ["INBOX"] },
      inbox: { addLabelIds: ["INBOX"] }, star: { addLabelIds: ["STARRED"] }, unstar: { removeLabelIds: ["STARRED"] }, trash: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    };
    let change = changes[action];
    if (action === "addLabel" || action === "removeLabel") {
      if (!label) throw new LouError("VALIDATION_FAILED", "Label name is required.");
      const labels = await this.call<{ labels: Array<{ id: string; name: string }> }>(`${API}/labels`, {}, signal);
      let found = labels.labels.find(l => l.name === label);
      if (!found && action === "addLabel") found = await this.call(`${API}/labels`, { json: { name: label } }, signal);
      change = action === "addLabel" ? { addLabelIds: found ? [found.id] : [] } : { removeLabelIds: found ? [found.id] : [] };
    }
    if (!change) throw new LouError("VALIDATION_FAILED", "Unknown Gmail action.");
    await this.call(`${API}/threads/${encodeURIComponent(threadId)}/modify`, { json: change }, signal);
    return { ok: true };
  }

  async getDraft(id: string, signal?: AbortSignal) {
    const draft = await this.call<{ id: string; message: { id: string; raw: string } }>(`${API}/drafts/${encodeURIComponent(id)}?format=raw`, {}, signal);
    return { id: draft.id, message: await this.readMessage(draft.message.id, signal), fingerprint: createHash("sha256").update(Buffer.from(draft.message.raw, "base64url")).digest("hex") };
  }

  async sendDraft(id: string, fingerprint: string | undefined, signal?: AbortSignal): Promise<{ id: string; threadId: string }> {
    if (!fingerprint || (await this.getDraft(id, signal)).fingerprint !== fingerprint) throw new LouError("CONFLICT", "Draft changed after approval. Review it again before sending.");
    return this.call(`${API}/drafts/send`, { json: { id } }, signal);
  }

  async updateDraft(id: string, raw: string, signal?: AbortSignal): Promise<{ id: string; message: { id: string; threadId: string } }> {
    return this.call(`${API}/drafts/${encodeURIComponent(id)}`, { method: "PUT", json: { message: { raw } } }, signal);
  }

  /** New INBOX message IDs since a history ID. Throws NOT_FOUND if the history ID is too old. */
  async newMessagesSince(startHistoryId: string, signal?: AbortSignal): Promise<{ messageIds: string[]; historyId: string }> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    do {
      const params = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.call<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>; historyId: string; nextPageToken?: string }>(
        `${API}/history?${params}`,
        {},
        signal,
      );
      for (const h of res.history ?? []) for (const added of h.messagesAdded ?? []) if (!added.message.labelIds?.includes("SENT")) ids.add(added.message.id);
      historyId = res.historyId;
      pageToken = res.nextPageToken;
    } while (pageToken);
    return { messageIds: [...ids], historyId };
  }

  private async call<T>(url: string, options: { json?: unknown; method?: "PUT" }, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(attempt > 0);
      try {
        return await fetchJson<T>(this.fetchImpl, url, { service: "Gmail", ...(options.method ? { method: options.method } : {}), headers: { authorization: `Bearer ${token}` }, json: options.json, signal });
      } catch (err) {
        // One forced refresh on 401; anything else propagates.
        if (attempt === 0 && err instanceof LouError && err.code === "AUTH_REQUIRED") continue;
        throw err;
      }
    }
  }
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function toMeta(m: GmailMessageResource): MessageMeta {
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(h, "From"),
    to: header(h, "To"),
    cc: header(h, "Cc"),
    bcc: header(h, "Bcc"),
    replyTo: header(h, "Reply-To"),
    subject: header(h, "Subject"),
    date: header(h, "Date") || (m.internalDate ? new Date(Number(m.internalDate)).toUTCString() : ""),
    messageIdHeader: header(h, "Message-ID"),
    references: header(h, "References"),
    snippet: decodeEntities(m.snippet ?? ""),
    labelIds: m.labelIds ?? [],
    unread: m.labelIds?.includes("UNREAD") ?? false,
    bulk: !!header(h, "List-Unsubscribe") || /bulk|list|junk/i.test(header(h, "Precedence")) || /auto-/i.test(header(h, "Auto-Submitted")),
  };
}

function decodeData(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function findPart(part: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mime && part.body?.data && !part.filename) return part;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return undefined;
}

export function extractBody(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  const text = plain ? decodeData(plain.body?.data) : htmlToText(decodeData(findPart(payload, "text/html")?.body?.data));
  return stripQuoted(text).trim();
}

function collectAttachments(part: GmailPart | undefined, out: string[] = []): string[] {
  if (!part) return out;
  if (part.filename) out.push(part.filename);
  for (const p of part.parts ?? []) collectAttachments(p, out);
  return out;
}

/** Removes quoted history so the model sees only the new content of each message. */
function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^From: .+$/.test(line) && out.length > 3) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
