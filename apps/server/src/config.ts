import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeModelSchema } from "@lou/protocol";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

export const SPOTIFY_CALLBACK_PATH = "/oauth/spotify/callback";

const EnvSchema = z.object({
  LOU_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOU_HOST: z.string().default("127.0.0.1"),
  LOU_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Public base URL (used for OAuth redirects and webhooks), e.g. https://lou.example.com */
  LOU_PUBLIC_URL: z.string().url().optional(),
  LOU_DATA_DIR: z.string().default("./data"),
  LOU_DB_PATH: z.string().optional(),
  /** base64-encoded 32-byte key for encrypting secrets at rest. */
  LOU_MASTER_KEY: z.string().optional(),
  LOU_SKILLS_DIR: z.string().optional(),
  LOU_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOU_TRUST_PROXY: bool.default(false),
  LOU_CORS_ORIGINS: z.string().optional(),
  LOU_USER_NAME: z.string().default("Owner"),
  LOU_TIMEZONE: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_ORG_ID: z.string().optional(),
  /** Default reasoning/router model: GPT-6 Luna. */
  LOU_MODEL: z.string().default("gpt-6-luna"),
  /** Optional higher-capability model for escalation (e.g. GPT-6 Sol). */
  LOU_ESCALATION_MODEL: z.string().optional(),
  LOU_CLASSIFIER_MODEL: z.string().optional(),
  LOU_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  LOU_TRANSCRIBE_MODEL: z.string().default("gpt-4o-transcribe"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  LOU_GMAIL_POLL_SECONDS: z.coerce.number().int().min(15).default(120),

  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  /** Spotify app (Web API) credentials. They can also be entered from the Windows app (Accounts → Spotify → Set up). */
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  /** Defaults to ${LOU_PUBLIC_URL}/oauth/spotify/callback (localhost becomes 127.0.0.1, which Spotify requires). */
  SPOTIFY_REDIRECT_URI: z
    .string()
    .url()
    .refine((u) => new URL(u).pathname.endsWith(SPOTIFY_CALLBACK_PATH), `SPOTIFY_REDIRECT_URI must end with ${SPOTIFY_CALLBACK_PATH}`)
    .optional(),

  /** Path to a JSON file describing MCP servers (see docs/INTEGRATIONS.md). */
  LOU_MCP_CONFIG: z.string().optional(),
  LOU_IMPROVEMENT_ENABLED: bool.default(true),

  /** Which model backend drives the assistant: the OpenAI API (API key), the local Codex CLI (ChatGPT/Codex login) or Claude Code (Claude login). */
  AI_PROVIDER: z.enum(["openai_api", "codex_cli", "claude_cli"]).default("openai_api"),
  /** Path to the codex executable (default: found on PATH). */
  CODEX_PATH: z.string().optional(),
  /** Model for Codex threads (default: the model configured in Codex). */
  LOU_CODEX_MODEL: z.string().optional(),
  /** Empty working directory given to Codex threads. */
  LOU_CODEX_WORKSPACE: z.string().optional(),
  LOU_CODEX_TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
  /** Path to the claude executable (default: found on PATH, ~/.local/bin or ~/.claude/local). */
  CLAUDE_PATH: z.string().optional(),
  /** Default model for Claude Code (alias such as "sonnet" or a full name); can be changed in Settings. */
  LOU_CLAUDE_MODEL: ClaudeModelSchema.optional(),
  /** Empty working directory given to Claude Code sessions. */
  LOU_CLAUDE_WORKSPACE: z.string().optional(),
  LOU_CLAUDE_TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env["LOU_ENV"];
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  masterKey?: string;
  skillsDir: string;
  logLevel: Env["LOU_LOG_LEVEL"];
  trustProxy: boolean;
  corsOrigins: string[];
  user: { name: string; timezone: string };
  openai: {
    apiKey?: string;
    baseURL?: string;
    organization?: string;
    model: string;
    escalationModel?: string;
    classifierModel?: string;
    embeddingModel: string;
    transcribeModel: string;
  };
  google: { clientId?: string; clientSecret?: string; pollSeconds: number };
  instagram: { appId?: string; appSecret?: string; verifyToken?: string };
  spotify: { clientId?: string; clientSecret?: string; redirectUri: string };
  mcpConfigPath?: string;
  improvementEnabled: boolean;
  aiProvider: "openai_api" | "codex_cli" | "claude_cli";
  codex: { path?: string; model?: string; workspaceDir: string; turnTimeoutMs: number };
  claude: { path?: string; model?: string; workspaceDir: string; turnTimeoutMs: number };
  version: string;
}

function repoRoot(): string {
  // src/config.ts or dist/index.js → apps/server → repo root
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "skills")) && existsSync(resolve(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.LOU_DATA_DIR);
  const publicUrl = (e.LOU_PUBLIC_URL ?? `http://${e.LOU_HOST === "0.0.0.0" ? "localhost" : e.LOU_HOST}:${e.LOU_PORT}`).replace(/\/$/, "");

  if (e.LOU_ENV === "production") {
    if (!e.LOU_MASTER_KEY) throw new Error("LOU_MASTER_KEY is required in production (generate one with `lou gen-key`).");
    if (!publicUrl.startsWith("https://")) throw new Error("LOU_PUBLIC_URL must be an https:// URL in production.");
  }

  return {
    env: e.LOU_ENV,
    host: e.LOU_HOST,
    port: e.LOU_PORT,
    publicUrl,
    dataDir,
    dbPath: resolve(e.LOU_DB_PATH ?? `${dataDir}/lou.db`),
    masterKey: e.LOU_MASTER_KEY,
    skillsDir: resolve(e.LOU_SKILLS_DIR ?? `${repoRoot()}/skills`),
    logLevel: e.LOU_LOG_LEVEL,
    trustProxy: e.LOU_TRUST_PROXY,
    corsOrigins: e.LOU_CORS_ORIGINS ? e.LOU_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : [],
    user: { name: e.LOU_USER_NAME, timezone: e.LOU_TIMEZONE },
    openai: {
      apiKey: e.OPENAI_API_KEY,
      baseURL: e.OPENAI_BASE_URL,
      organization: e.OPENAI_ORG_ID,
      model: e.LOU_MODEL,
      escalationModel: e.LOU_ESCALATION_MODEL,
      classifierModel: e.LOU_CLASSIFIER_MODEL,
      embeddingModel: e.LOU_EMBEDDING_MODEL,
      transcribeModel: e.LOU_TRANSCRIBE_MODEL,
    },
    google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, pollSeconds: e.LOU_GMAIL_POLL_SECONDS },
    instagram: { appId: e.INSTAGRAM_APP_ID, appSecret: e.INSTAGRAM_APP_SECRET, verifyToken: e.INSTAGRAM_WEBHOOK_VERIFY_TOKEN },
    spotify: { clientId: e.SPOTIFY_CLIENT_ID || undefined, clientSecret: e.SPOTIFY_CLIENT_SECRET || undefined, redirectUri: e.SPOTIFY_REDIRECT_URI ?? spotifyRedirectUri(publicUrl) },
    mcpConfigPath: e.LOU_MCP_CONFIG ? resolve(e.LOU_MCP_CONFIG) : undefined,
    improvementEnabled: e.LOU_IMPROVEMENT_ENABLED,
    aiProvider: e.AI_PROVIDER,
    codex: {
      path: e.CODEX_PATH,
      model: e.LOU_CODEX_MODEL,
      workspaceDir: resolve(e.LOU_CODEX_WORKSPACE ?? `${dataDir}/codex-workspace`),
      turnTimeoutMs: e.LOU_CODEX_TURN_TIMEOUT_SECONDS * 1000,
    },
    claude: {
      path: e.CLAUDE_PATH,
      model: e.LOU_CLAUDE_MODEL,
      workspaceDir: resolve(e.LOU_CLAUDE_WORKSPACE ?? `${dataDir}/claude-workspace`),
      turnTimeoutMs: e.LOU_CLAUDE_TURN_TIMEOUT_SECONDS * 1000,
    },
    version: "0.1.0",
  };
}

/**
 * Spotify only accepts HTTPS redirect URIs or loopback IP literals; `localhost`
 * is rejected, so the development default uses 127.0.0.1 instead.
 */
export function spotifyRedirectUri(publicUrl: string): string {
  const url = new URL(`${publicUrl}${SPOTIFY_CALLBACK_PATH}`);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}
