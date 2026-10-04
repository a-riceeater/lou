/**
 * Prompt-injection boundary helpers.
 *
 * External content (email, DMs, web pages, files, webhook payloads) is wrapped in a
 * clearly delimited envelope before it reaches the model. The system prompt tells the
 * model that anything inside the envelope is data, never instructions. Any attempt by
 * the content to close the envelope early is neutralized.
 */
export const UNTRUSTED_TAG = "external_data";

export function escapeUntrusted(text: string): string {
  // Prevent the content from forging an envelope boundary in either direction.
  return text.replace(/<\s*\/?\s*external_data[^>]*>/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

export function wrapUntrusted(source: string, content: string): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return `<${UNTRUSTED_TAG} source="${safeSource}" trust="untrusted">\n${escapeUntrusted(content)}\n</${UNTRUSTED_TAG}>`;
}
