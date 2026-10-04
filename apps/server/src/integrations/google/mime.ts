/**
 * Minimal RFC 5322 / MIME message builder for plain-text Gmail sends and replies.
 * The body is base64-encoded UTF-8 so any characters survive transport intact.
 */
export interface OutgoingEmail {
  from?: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

export function encodeHeaderValue(value: string): string {
  // Strip CR/LF to prevent header injection from any input.
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function addressList(list: string[]): string {
  return list.map((a) => a.replace(/[\r\n]+/g, " ").trim()).filter(Boolean).join(", ");
}

export function buildMime(email: OutgoingEmail): string {
  const headers: string[] = [];
  if (email.from) headers.push(`From: ${addressList([email.from])}`);
  headers.push(`To: ${addressList(email.to)}`);
  if (email.cc?.length) headers.push(`Cc: ${addressList(email.cc)}`);
  headers.push(`Subject: ${encodeHeaderValue(email.subject)}`);
  if (email.inReplyTo) headers.push(`In-Reply-To: ${encodeHeaderValue(email.inReplyTo)}`);
  if (email.references) headers.push(`References: ${encodeHeaderValue(email.references)}`);
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
  const body = Buffer.from(email.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Gmail API expects the raw message as base64url. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

/** Parses `"Name" <addr@x>` lists into bare addresses + display names. */
export function parseAddresses(header: string | undefined): Array<{ name: string | null; email: string }> {
  if (!header) return [];
  const out: Array<{ name: string | null; email: string }> = [];
  // Split on commas that are not inside quotes.
  for (const part of header.match(/("[^"]*"|[^,])+/g) ?? []) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(part);
    if (m) out.push({ name: m[1]?.trim() || null, email: m[2]!.trim().toLowerCase() });
    else if (part.includes("@")) out.push({ name: null, email: part.trim().toLowerCase() });
  }
  return out;
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}
