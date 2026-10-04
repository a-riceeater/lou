/**
 * Deterministic tool-family selection (AGENT_SYSTEM.md §13). Cheap keyword
 * matching picks a small tool subset for the first model turn; the model can ask
 * for more with the `tools.enable_family` meta tool, and loaded skills add the
 * tools they reference. This keeps the prompt small and cache-friendly.
 */
export interface ToolFamily {
  id: string;
  /** One-line description shown to the model in the family index. */
  description: string;
  /** Lowercase keywords or phrases. */
  keywords: readonly string[];
  /** Always exposed regardless of the request. */
  core?: boolean;
}

export const BUILTIN_FAMILIES: readonly ToolFamily[] = [
  {
    id: "core",
    description: "Memory and skill lookup.",
    keywords: [],
    core: true,
  },
  {
    id: "gmail",
    description: "Search, read, draft and reply to email in connected Gmail accounts.",
    keywords: ["email", "e-mail", "mail", "gmail", "inbox", "reply", "respond", "thread", "unread", "sent", "send", "message from", "wrote", "cc", "subject"],
  },
  {
    id: "instagram",
    description: "Read and reply to Instagram direct messages on connected professional accounts.",
    keywords: ["instagram", "insta", "ig", "dm", "dms", "direct message"],
  },
  {
    id: "device",
    description: "Act on the user's computer: open apps, links and files, search files, clipboard, read and use app windows, show notifications.",
    keywords: [
      "open",
      "launch",
      "start",
      "clipboard",
      "copy",
      "paste",
      "file",
      "files",
      "folder",
      "document",
      "window",
      "app",
      "click",
      "press",
      "website",
      "url",
      "link",
      "browser",
      "notify",
      "notification",
      "remind",
      "screen",
      "desktop",
      "downloads",
    ],
  },
  {
    id: "workflow",
    description: "Run saved deterministic workflows.",
    keywords: ["workflow", "routine", "usual"],
  },
];

const WORD = /[a-z0-9@.'-]+/g;

export function selectFamilies(text: string, families: readonly ToolFamily[]): string[] {
  const lower = text.toLowerCase();
  const words = new Set(lower.match(WORD) ?? []);
  const selected = new Set<string>();
  for (const family of families) {
    if (family.core) {
      selected.add(family.id);
      continue;
    }
    for (const kw of family.keywords) {
      const hit = kw.includes(" ") ? lower.includes(kw) : words.has(kw);
      if (hit) {
        selected.add(family.id);
        break;
      }
    }
  }
  return [...selected];
}
