import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LouError } from "@lou/shared";
import { readCliVersion, runCliCapture } from "../cli";
import { LOU_MCP_SERVER, LouToolBridge, type BridgeSession } from "./bridge";
import { describeMissingClaude, findClaudeExecutable, type ClaudeCommand } from "./discovery";

export type ClaudeState = "stopped" | "starting" | "ready" | "not_installed" | "not_signed_in" | "error";

export interface ClaudeHealth {
  state: ClaudeState;
  installed: boolean;
  executable: string | null;
  cliVersion: string | null;
  signedIn: boolean;
  /** How Claude Code is authenticated. Never includes tokens, e-mail or organization. */
  auth: { method: "subscription" | "apiKey" | "cloud" | "other"; plan: string | null; provider: string | null } | null;
  restricted: boolean;
  lastError: string | null;
}

export interface ClaudeLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
}

export interface ClaudeCliOptions {
  /** Explicit path to claude (CLAUDE_PATH). Otherwise PATH is searched. */
  explicitPath?: string;
  /** Empty working directory for Claude sessions; Claude gets no project files. */
  workspaceDir: string;
  logger?: ClaudeLogger;
  env?: NodeJS.ProcessEnv;
  /** Max bytes of output per turn before the process is considered runaway. */
  maxOutputBytes?: number;
  /** How long a successful status check is trusted before checking again. */
  recheckMs?: number;
  /** Test hook: discovery result override. */
  command?: ClaudeCommand;
}

export interface ClaudeTurnOptions {
  prompt: string;
  systemPrompt: string;
  model?: string;
  /** Persisted session to start (`resume: false`) or continue; omitted for a throwaway session. */
  session?: { id: string; resume: boolean };
  /** Lou tools for this turn, served by the loopback MCP bridge. */
  tools?: BridgeSession;
  /** Structured output: the final answer must match this JSON schema. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onDelta?(text: string): void;
}

export interface ClaudeTurnResult {
  sessionId: string | null;
  model: string | null;
  text: string;
  /** Present when a JSON schema was requested and Claude produced it. */
  structured: unknown;
  /** Set when Claude Code reported the turn as failed. */
  error: LouError | null;
}

/** Flags Lou's lockdown depends on; a CLI without them is refused. */
const REQUIRED_FLAGS = ["--print", "--output-format", "--tools", "--mcp-config", "--strict-mcp-config", "--setting-sources", "--permission-mode", "--system-prompt", "--allowedTools"];

/** Arguments that must never be passed, whatever the configuration says. */
const FORBIDDEN_ARGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"];

/** Built-in tool Claude Code uses to return structured output; allowed only when a schema was requested. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const LOGIN_HINT = "claude auth login";

/**
 * Runs Claude Code (`claude -p`) for Lou: discovery, version, auth detection,
 * capability lockdown, the `stream-json` event protocol, and process safety.
 * Each turn is one child process spawned with an argv array (no shell); the
 * prompt travels over stdin. Sessions persist in Claude Code's own store and
 * are continued with `--resume`, so history isn't re-sent.
 *
 * Lockdown: every built-in tool is off (`--tools ""`), the only MCP server is
 * Lou's loopback bridge (`--strict-mcp-config`), user/project settings, hooks,
 * plugins and CLAUDE.md files are not loaded (`--setting-sources ""`), and the
 * permission mode denies anything not pre-approved. The init event and every
 * tool use are verified; anything else stops the turn.
 */
export class ClaudeCliManager {
  private readonly bridge = new LouToolBridge();
  private readonly children = new Set<ReturnType<typeof spawn>>();
  private checking: Promise<void> | undefined;
  private checkedAt = 0;
  private command: ClaudeCommand | undefined;
  private flags = new Set<string>();
  private permissionMode = "default";
  private readonly killAll = () => {
    for (const child of this.children) child.kill();
  };
  private status: ClaudeHealth = {
    state: "stopped",
    installed: false,
    executable: null,
    cliVersion: null,
    signedIn: false,
    auth: null,
    restricted: false,
    lastError: null,
  };

  constructor(private readonly options: ClaudeCliOptions) {}

  get state(): ClaudeState {
    return this.status.state;
  }

  /** Current status without checking anything (cheap; for settings UI polling). */
  snapshot(): ClaudeHealth {
    return { ...this.status, auth: this.status.auth ? { ...this.status.auth } : null };
  }

  /** Checks installation, version and sign-in (now, or reusing a recent check) and reports health. Never throws. */
  async health(force = true): Promise<ClaudeHealth> {
    if (force) this.checkedAt = 0;
    try {
      await this.ensureReady();
    } catch {
      /* reflected in status */
    }
    return this.snapshot();
  }

  /** Idempotent: verifies the CLI is installed, recent enough and signed in. */
  async ensureReady(): Promise<void> {
    if (this.status.state === "ready" && Date.now() - this.checkedAt < (this.options.recheckMs ?? 10 * 60_000)) return;
    this.checking ??= this.check().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  async stop(): Promise<void> {
    this.killAll();
    this.children.clear();
    process.off("exit", this.killAll);
    await this.bridge.stop();
    this.status.state = "stopped";
  }

  /** Runs one locked-down Claude Code turn and returns its outcome. */
  async runTurn(turn: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
    if (turn.signal?.aborted) throw new LouError("CANCELLED", "Cancelled.");
    await this.ensureReady();
    const command = this.command!;
    mkdirSync(this.options.workspaceDir, { recursive: true });

    const lease = turn.tools ? await this.bridge.open(turn.tools) : undefined;
    // The bridge token goes in a private file, never on the command line where other local users could read it.
    const configDir = lease ? mkdtempSync(join(tmpdir(), "lou-claude-")) : undefined;
    try {
      let mcpConfig: string | undefined;
      if (lease && configDir) {
        mcpConfig = join(configDir, "mcp.json");
        writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [LOU_MCP_SERVER]: { type: "http", url: lease.url, headers: { Authorization: `Bearer ${lease.token}` } } } }), { mode: 0o600 });
      }
      const args = this.turnArgs(turn, mcpConfig);
      return await this.spawnTurn(command, args, turn);
    } finally {
      lease?.close();
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------

  private async check(): Promise<void> {
    this.status.state = "starting";
    this.status.lastError = null;
    const env = this.options.env ?? process.env;
    try {
      const command = this.options.command ?? findClaudeExecutable({ explicitPath: this.options.explicitPath, env });
      if (!command) {
        const reason = describeMissingClaude(this.options.explicitPath, env);
        this.status = { ...this.status, state: "not_installed", installed: false, executable: null, lastError: reason };
        throw new LouError(
          "NOT_CONFIGURED",
          this.options.explicitPath ? `Claude Code couldn't be found: ${reason}. Install it with: npm install -g @anthropic-ai/claude-code, or fix CLAUDE_PATH` : "Claude Code isn't installed on the server. Install it with: npm install -g @anthropic-ai/claude-code",
        );
      }
      this.command = command;
      this.status.installed = true;
      this.status.executable = command.resolvedPath;
      this.status.cliVersion = (await readCliVersion(command)) ?? this.status.cliVersion;
      mkdirSync(this.options.workspaceDir, { recursive: true });

      const help = (await runCliCapture(command, ["--help"], { env, cwd: this.options.workspaceDir })) ?? "";
      this.flags = new Set(help.match(/--[A-Za-z][\w-]*/g) ?? []);
      const missing = REQUIRED_FLAGS.filter((f) => !this.flags.has(f));
      if (missing.length) {
        this.status.state = "error";
        this.status.lastError = `Claude Code ${this.status.cliVersion ?? ""} is too old for Lou (no ${missing.join(", ")}). Update it: claude update`.replace("  ", " ");
        throw new LouError("NOT_CONFIGURED", `This Claude Code version can't be locked down to Lou's tools (no ${missing.join(", ")}). Update it with: claude update`);
      }
      this.permissionMode = /\bdontAsk\b/.test(help) ? "dontAsk" : "default";

      await this.checkAuth(command, env);
      this.status.state = "ready";
      this.status.restricted = true;
      this.checkedAt = Date.now();
      process.off("exit", this.killAll);
      process.once("exit", this.killAll);
      this.options.logger?.info({ version: this.status.cliVersion, auth: this.status.auth?.method }, "claude code ready");
    } catch (err) {
      if (this.status.state === "starting") this.status.state = "error";
      this.status.lastError ??= (err as Error).message;
      throw err;
    }
  }

  /** Reads `claude auth status --json`, keeping only the method and plan. */
  private async checkAuth(command: ClaudeCommand, env: NodeJS.ProcessEnv): Promise<void> {
    const out = await runCliCapture(command, ["auth", "status", "--json"], { env, cwd: this.options.workspaceDir, timeoutMs: 20_000 });
    let parsed: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown; subscriptionType?: unknown } | undefined;
    try {
      parsed = out ? JSON.parse(out.slice(out.indexOf("{"))) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed.loggedIn !== "boolean") {
      // Older CLIs have no `auth status`; a missing login then surfaces on the first request.
      this.status.auth = null;
      this.status.signedIn = true;
      return;
    }
    const method = String(parsed.authMethod ?? "");
    const provider = typeof parsed.apiProvider === "string" && parsed.apiProvider !== "firstParty" ? parsed.apiProvider : null;
    this.status.signedIn = parsed.loggedIn;
    this.status.auth = parsed.loggedIn
      ? {
          method: provider ? "cloud" : /claude\.ai|oauth|subscription/i.test(method) ? "subscription" : /key|token/i.test(method) ? "apiKey" : "other",
          plan: typeof parsed.subscriptionType === "string" && parsed.subscriptionType ? parsed.subscriptionType : null,
          provider,
        }
      : null;
    if (!parsed.loggedIn) throw this.signedOut();
  }

  private turnArgs(turn: ClaudeTurnOptions, mcpConfig: string | undefined): string[] {
    const has = (flag: string) => this.flags.has(flag);
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(turn.onDelta && has("--include-partial-messages") ? ["--include-partial-messages"] : []),
      "--tools",
      "",
      "--strict-mcp-config",
      ...(mcpConfig ? ["--mcp-config", mcpConfig, "--allowedTools", `mcp__${LOU_MCP_SERVER}`] : []),
      "--setting-sources",
      "",
      ...(has("--disable-slash-commands") ? ["--disable-slash-commands"] : []),
      "--permission-mode",
      this.permissionMode,
      "--system-prompt",
      turn.systemPrompt,
      ...(turn.model ? ["--model", turn.model] : []),
      ...(turn.session ? [turn.session.resume ? "--resume" : "--session-id", turn.session.id] : has("--no-session-persistence") ? ["--no-session-persistence"] : []),
      ...(turn.jsonSchema ? ["--json-schema", JSON.stringify(turn.jsonSchema)] : []),
    ];
    if (args.some((a) => FORBIDDEN_ARGS.some((f) => a === f || a.startsWith(`${f}=`)))) {
      throw new LouError("POLICY_DENIED", "Refusing to start Claude Code with unsafe arguments.");
    }
    return args;
  }

  private spawnTurn(command: ClaudeCommand, args: string[], turn: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
    const allowedTool = (name: string) => name.startsWith(`mcp__${LOU_MCP_SERVER}__`) || (!!turn.jsonSchema && name === STRUCTURED_OUTPUT_TOOL);
    return new Promise<ClaudeTurnResult>((resolveTurn, rejectTurn) => {
      const child = spawn(command.file, [...command.prefixArgs, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        cwd: this.options.workspaceDir,
        env: { ...(this.options.env ?? process.env) },
      });
      this.children.add(child);

      const max = this.options.maxOutputBytes ?? 16 * 1024 * 1024;
      let buffer = "";
      let total = 0;
      let stderrTail = "";
      let sessionId: string | null = null;
      let model: string | null = null;
      let lastText = "";
      let result: { subtype?: string; is_error?: boolean; result?: unknown; structured_output?: unknown; session_id?: string } | undefined;
      let failure: LouError | undefined;
      let settled = false;

      const stop = (err: LouError) => {
        failure ??= err;
        child.kill();
      };
      const timer = setTimeout(() => stop(new LouError("TIMEOUT", "Claude took too long to respond.")), turn.timeoutMs ?? 5 * 60_000);
      const onAbort = () => stop(new LouError("CANCELLED", "Cancelled."));
      turn.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        turn.signal?.removeEventListener("abort", onAbort);
        this.children.delete(child);
        if (failure) return rejectTurn(failure);
        if (!result) {
          this.options.logger?.warn({ code, stderr: redact(stderrTail.slice(-2000)) }, "claude code exited without a result");
          if (/no conversation found/i.test(stderrTail)) return rejectTurn(new LouError("NOT_FOUND", "Claude Code no longer has this conversation."));
          if (isAuthError(stderrTail)) return rejectTurn(this.signedOut());
          return rejectTurn(new LouError("UPSTREAM_ERROR", `Claude Code stopped unexpectedly (exit ${code ?? "signal"}).`, { retryable: true }));
        }
        const text = typeof result.result === "string" ? result.result : lastText;
        resolveTurn({
          sessionId: result.session_id ?? sessionId,
          model,
          text: text.trim(),
          structured: result.structured_output,
          error: result.is_error || (result.subtype && result.subtype !== "success") ? this.resultError(text, result.subtype) : null,
        });
      };

      const onEvent = (event: ClaudeEvent) => {
        switch (event.type) {
          case "system":
            if (event.subtype !== "init") break;
            sessionId = event.session_id ?? null;
            model = event.model ?? null;
            {
              const tools = event.tools ?? [];
              const servers = event.mcp_servers ?? [];
              const foreignTool = tools.find((t) => !allowedTool(t));
              const foreignServer = servers.find((s) => s.name !== LOU_MCP_SERVER);
              if (foreignTool || foreignServer) {
                stop(new LouError("POLICY_DENIED", `Claude Code wasn't locked down to Lou's tools (${foreignTool ?? foreignServer?.name}); the request was stopped.`));
              } else if (turn.tools && servers.some((s) => s.name === LOU_MCP_SERVER && /failed|needs-auth/i.test(s.status ?? ""))) {
                stop(new LouError("UPSTREAM_ERROR", "Claude Code couldn't connect to Lou's tools.", { retryable: true }));
              }
            }
            break;
          case "stream_event":
            if (event.parent_tool_use_id) break;
            if (event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta" && typeof event.event.delta.text === "string") {
              turn.onDelta?.(event.event.delta.text);
            }
            break;
          case "assistant":
            for (const block of event.message?.content ?? []) {
              if (block.type === "tool_use" && typeof block.name === "string" && !allowedTool(block.name)) {
                stop(new LouError("POLICY_DENIED", `Claude tried to use a capability Lou doesn't allow (${block.name}); the request was stopped.`));
              } else if (block.type === "text" && typeof block.text === "string" && !event.parent_tool_use_id) {
                lastText = block.text;
              }
            }
            break;
          case "result":
            result = event;
            break;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        total += chunk.length;
        if (total > max) return stop(new LouError("UPSTREAM_ERROR", "Claude Code produced too much output."));
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: ClaudeEvent;
          try {
            event = JSON.parse(line);
          } catch {
            this.options.logger?.debug?.({}, "ignored non-JSON line from claude");
            continue;
          }
          onEvent(event);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Keep a bounded tail for diagnostics; never log it wholesale.
        stderrTail = (stderrTail + chunk).slice(-16_384);
      });
      child.on("error", (err) => {
        failure ??= new LouError("NOT_CONFIGURED", `Couldn't start Claude Code: ${err.message}`);
        finish(null);
      });
      child.on("close", (code) => finish(code));
      child.stdin.on("error", () => undefined);
      child.stdin.end(turn.prompt);
    });
  }

  private resultError(text: string, subtype: string | undefined): LouError {
    if (isAuthError(text)) return this.signedOut();
    if (/rate.?limit|usage limit|limit reached|overloaded/i.test(text)) return new LouError("RATE_LIMITED", `Claude: ${text || "rate limited"}`, { retryable: true });
    if (subtype === "error_max_turns") return new LouError("MODEL_ERROR", "Claude couldn't finish this in a reasonable number of steps.");
    return new LouError("MODEL_ERROR", text ? `Claude: ${text}` : "Claude couldn't complete this request.");
  }

  /** Records a lost or missing login (shown in Settings) and returns the error for the request. */
  private signedOut(): LouError {
    this.status.state = "not_signed_in";
    this.status.signedIn = false;
    this.status.auth = null;
    this.status.lastError = `Not signed in. Run: ${LOGIN_HINT}`;
    this.checkedAt = 0;
    return new LouError("NOT_CONFIGURED", `Claude Code isn't signed in. Run: ${LOGIN_HINT}`);
  }
}

interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: Array<{ type: string; name?: string; text?: string }> };
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
}

function isAuthError(text: string): boolean {
  return /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i.test(text);
}

function redact(text: string): string {
  return text.replace(/(eyJ[\w-]{10,}\.[\w-]+\.[\w-]+|sk-ant-[\w-]{16,}|sk-[\w-]{16,}|Bearer\s+\S+)/g, "[redacted]");
}
