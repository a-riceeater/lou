import { LouError } from "@lou/shared";
import type { ToolRegistry } from "@lou/tools";
import { z } from "zod";
import type { IntegrationManager } from "../manager";
import type { GmailProvider } from "./provider";
import { CommandInput, type ScriptCommandInput } from "./script-protocol";

/** Additional ordinary Gmail tools share policy, approvals, and provider selection. */
export function registerExtendedGmailTools(registry: ToolRegistry, integrations: IntegrationManager, client: (id: string) => GmailProvider) {
  const specs = [
    ["read_message", "MESSAGE", "Read one email, including attachment metadata", false],
    ["read_attachment", "ATTACHMENT", "Fetch an attachment by message ID and attachment index (maximum 500 KB)", false],
    ["modify", "MODIFY", "Mark a thread read/unread, archive, move to inbox/trash, star/unstar, or add/remove a label", true],
    ["create_draft", "DRAFT", "Create an email draft, optionally with HTML, BCC, and attachments", true],
    ["update_draft", "UPDATE_DRAFT", "Update an existing email draft", true],
    ["send_draft", "SEND_DRAFT", "Send an existing email draft after approval", true],
    ["forward", "FORWARD", "Forward an email and its attachments after approval", true],
  ] as const;
  for (const [name, operation, description, write] of specs) {
    const commandSchema = CommandInput.options.find(schema => schema.shape.operation.value === operation)!;
    const inputSchema = z.object({ accountId: z.string().optional(), command: commandSchema });
    registry.register({ id: `gmail.${name}`, family: "gmail", title: description, description: `${description}. Supply command.operation = ${operation}.`, input: inputSchema,
      timeoutMs: 150_000, risk: write ? "write" : "read", executionTarget: "server", requiresApproval: write, exposure: "model", untrustedOutput: !write,
    }, {
      async prepare(input, ctx) {
        const account = integrations.resolveAccount(ctx.userId, "google", input.accountId);
        let summary = "";
        const command = CommandInput.parse(input.command);
        let draftMessage: { to: string; cc: string; bcc?: string; subject: string; body: string; attachments?: string[] } | undefined;
        if (command.operation === "SEND_DRAFT") {
          const draft = await client(account.id).command({ operation: "DRAFT_MESSAGE", draftId: command.draftId }, ctx.signal) as { message: typeof draftMessage; fingerprint: string };
          command.fingerprint = draft.fingerprint;
          draftMessage = draft.message;
          summary = "The draft must remain unchanged after approval.";
        }
        const email = "email" in command ? command.email : undefined;
        return { input: { accountId: account.id, command }, presentation: { kind: "email.action", title: description, account: account.address ?? "", summary,
          fields: email ? [
            { key: "to", label: "To / CC / BCC", kind: "recipients", value: [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])].join(", ") },
            { key: "subject", label: "Subject", kind: "text", value: email.subject },
            { key: "body", label: "Message", kind: "longtext", value: email.body },
            { key: "htmlBody", label: "HTML message", kind: "longtext", value: email.htmlBody ?? "" },
            { key: "attachments", label: "Attachments", kind: "text", value: (email.attachments ?? []).map(a => a.filename).join(", ") },
          ] : draftMessage ? [
            { key: "to", label: "To / CC / BCC", kind: "recipients", value: [draftMessage.to, draftMessage.cc, draftMessage.bcc ?? ""].filter(Boolean).join(", ") },
            { key: "subject", label: "Subject", kind: "text", value: draftMessage.subject },
            { key: "body", label: "Message", kind: "longtext", value: draftMessage.body },
            { key: "attachments", label: "Attachments", kind: "text", value: (draftMessage.attachments ?? []).join(", ") },
          ] : [{ key: "command", label: "Action", kind: "longtext", value: JSON.stringify(command) }],
        } };
      },
      async execute(input, ctx) {
        const account = integrations.resolveAccount(ctx.userId, "google", input.accountId);
        const command = CommandInput.parse(input.command) as ScriptCommandInput;
        if (command.operation !== operation) throw new LouError("VALIDATION_FAILED", "Wrong Gmail operation.");
        return client(account.id).command(command, ctx.signal, ctx.approvalId);
      },
    });
  }
}
