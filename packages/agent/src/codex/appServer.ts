import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { LouError } from "@lou/shared";
import { describeMissingCodex, findCodexExecutable, readCodexVersion, type CodexCommand } from "./discovery";
import {
  CODEX_APPROVAL_REQUESTS,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type GetAccountResponse,
  type InitializeResponse,
  type McpServerStatus,
  type RpcNotification,
  type RpcResponse,
  type RpcServerRequest,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnStartParams,
  type Turn,
} from "./protocol";

export type CodexState = "stopped" | "starting" | "ready" | "not_installed" | "not_signed_in" | "crashed" | "error";

export interface CodexHealth {
  state: CodexState;
  installed: boolean;
  executable: string | null;
  cliVersion: string | null;
  signedIn: boolean;
  /** How Codex is authenticated. Never includes tokens or account identifiers. */
  auth: { mode: "chatgpt" | "apiKey" | "bedrock"; plan: string | null } | null;
  codexHome: string | null;
  restarts: number;
  restricted: boolean;
  disabledMcpServers: string[];
  lastError: string | null;
}

export interface CodexLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
}

export interface CodexAppServerOptions {
  /** Explicit path to codex (CODEX_PATH). Otherwise PATH is searched. */
  explicitPath?: string;
  /** Empty working directory for Codex threads; Codex gets no project files. */
  workspaceDir: string;
  clientVersion: string;
  logger?: CodexLogger;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /** Max bytes of a single protocol line before the process is considered runaway. */
  maxLineBytes?: number;
  /** Restart budget: at most `maxRestarts` within `restartWindowMs`. */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Test hook: discovery result override. */
  command?: CodexCommand;
}

/**
 * Codex features turned off for Lou threads. Lou's own registered tools (with
 * policy and approvals) are the only way the assistant acts; Codex's shell,
 * patching, browser/computer use, plugins, apps, sub-agents etc. stay off.
 * Only names the installed CLI reports are passed, so newer/older versions work.
 */
export const LOCKDOWN_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "apply_patch_freeform",
  "js_repl",
  "code_mode",
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "in_app_local_automation",
  "image_generation",
  "web_search_request",
  "web_search_cached",
  "standalone_web_search",
  "search_tool",
  "tool_search",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "memories",
  "goals",
  "hooks",
  "request_permissions_tool",
];

/**
 * Codex features Lou's tools depend on. Models that are "code mode only" in the
 * Codex catalog call dynamic tools from a JavaScript `exec` cell run by the
 * code-mode host; with the host off, every Lou tool call fails inside Codex
 * ("code-mode host is disabled") before it reaches Lou. The cell can only call
 * the thread's dynamic tools, so Lou's policy and approvals still govern them.
 */
export const REQUIRED_FEATURES = ["code_mode_host"];

/** Arguments that must never be passed, whatever the configuration says. */
const FORBIDDEN_ARGS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "danger-full-access"];

type ServerRequestHandler = (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owns the persistent `codex app-server --listen stdio://` child process:
 * discovery, version, auth detection, capability lockdown, newline-delimited
 * JSON-RPC, server→client requests, crash detection with bounded restarts, and
 * shutdown. Spawned with an argv array (no shell); prompts travel over stdin.
 */
export class CodexAppServerManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stopping = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(n: RpcNotification) => void>();
  private readonly exitHandlers = new Set<(reason: string) => void>();
  private toolCallHandler: ServerRequestHandler | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private readonly loadedThreads = new Set<string>();
  private readonly restartTimes: number[] = [];
  private generationCounter = 0;
  private lockdownArgs: string[] | undefined;
  private appServerSupported: boolean | undefined;
  private command: CodexCommand | undefined;
  private readonly killOnExit = () => this.child?.kill();
  private status: CodexHealth = {
    state: "stopped",
    installed: false,
    executable: null,
    cliVersion: null,
    signedIn: false,
    auth: null,
    codexHome: null,
    restarts: 0,
    restricted: false,
    disabledMcpServers: [],
    lastError: null,
  };

  constructor(private readonly options: CodexAppServerOptions) {}

  /** Increments every time a new App Server process becomes ready. */
  get generation(): number {
    return this.generationCounter;
  }

  get state(): CodexState {
    return this.status.state;
  }

  onNotification(handler: (n: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Called when the process exits unexpectedly (in-flight turns should fail). */
  onExit(handler: (reason: string) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  setToolCallHandler(handler: ServerRequestHandler): void {
    this.toolCallHandler = handler;
  }

  /** Current status without starting anything (cheap; for settings UI polling). */
  snapshot(): CodexHealth {
    return { ...this.status, auth: this.status.auth ? { ...this.status.auth } : null, disabledMcpServers: [...this.status.disabledMcpServers] };
  }

  /** Starts (if needed) and reports health. Never throws. */
  async health(): Promise<CodexHealth> {
    try {
      await this.ensureStarted();
    } catch {
      /* reflected in status */
    }
    return this.snapshot();
  }

  /** Idempotent: starts, initializes, checks auth and restricts the App Server. */
  async ensureStarted(): Promise<void> {
    if (this.child && this.status.state === "ready") return;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async request<T>(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    await this.ensureStarted();
    return this.rawRequest<T>(method, params, options);
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const res = await this.request<ThreadStartResponse>("thread/start", { cwd: this.options.workspaceDir, approvalPolicy: "never", sandbox: "read-only", ...params });
    this.loadedThreads.add(res.thread.id);
    return res;
  }

  /** Ensures a persisted thread is loaded in the current process (after restarts). */
  async ensureThreadLoaded(threadId: string, params: Omit<ThreadStartParams, "dynamicTools" | "ephemeral"> = {}): Promise<void> {
    await this.ensureStarted();
    if (this.loadedThreads.has(threadId)) return;
    await this.rawRequest("thread/resume", { threadId, cwd: this.options.workspaceDir, approvalPolicy: "never", sandbox: "read-only", excludeTurns: true, ...params });
    this.loadedThreads.add(threadId);
  }

  async startTurn(params: TurnStartParams): Promise<Turn> {
    const res = await this.request<{ turn: Turn }>("turn/start", params, { timeoutMs: 60_000 });
    return res.turn;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (!this.child) return;
    await this.rawRequest("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    process.off("exit", this.killOnExit);
    if (child) {
      child.stdin.end();
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          child.kill();
          resolveStop();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    }
    this.failPending(new LouError("CANCELLED", "Codex was stopped."));
    this.loadedThreads.clear();
    this.status.state = "stopped";
    this.stopping = false;
  }

  // ---------------------------------------------------------------------------

  private async start(): Promise<void> {
    await this.waitForRestartBudget();
    this.status.state = "starting";
    this.status.lastError = null;

    const command = this.options.command ?? findCodexExecutable({ explicitPath: this.options.explicitPath, env: this.options.env });
    if (!command) {
      const reason = describeMissingCodex(this.options.explicitPath, this.options.env);
      this.status = { ...this.status, state: "not_installed", installed: false, executable: null, lastError: reason };
      throw new LouError("NOT_CONFIGURED", this.options.explicitPath ? `Codex CLI couldn't be found: ${reason}. Install it with: npm install -g @openai/codex, or fix CODEX_PATH` : "Codex CLI isn't installed on the server. Install it with: npm install -g @openai/codex");
    }
    this.status.installed = true;
    this.status.executable = command.resolvedPath;
    this.status.cliVersion ??= (await readCodexVersion(command)) ?? null;
    mkdirSync(this.options.workspaceDir, { recursive: true });

    this.command = command;
    if (this.appServerSupported === false) throw this.appServerMissingError();

    // Phase 1 (first start only): discover which features this CLI version knows,
    // so the locked-down launch only passes names it understands.
    if (!this.lockdownArgs) {
      await this.spawnProcess(command, []);
      try {
        try {
          await this.initialize();
        } catch (err) {
          if (/unrecognized subcommand|unexpected argument 'app-server'|no such (sub)?command/i.test(this.stderrTail)) {
            this.appServerSupported = false;
            throw this.appServerMissingError();
          }
          throw err;
        }
        this.appServerSupported = true;
        const signedIn = await this.checkAuth();
        if (!signedIn) {
          await this.stopProcess();
          throw new LouError("NOT_CONFIGURED", "Codex CLI isn't signed in. Run: codex login");
        }
        this.lockdownArgs = await this.computeFeatureLockdown();
      } catch (err) {
        if (this.status.state === "starting") this.status.state = "error";
        this.status.lastError = (err as Error).message;
        throw err;
      } finally {
        await this.stopProcess();
      }
    }

    // Phase 2: the restricted process Lou actually uses. MCP servers are checked
    // *with* features disabled: built-ins (e.g. the apps runtime) disappear then,
    // and only user-configured servers that still expose tools are disabled by name.
    try {
      await this.spawnLocked(command);
      const exposed = (await this.listMcpServers()).filter((s) => Object.keys(s.tools ?? {}).length > 0 && /^[A-Za-z0-9_-]+$/.test(s.name));
      if (exposed.length) {
        this.status.disabledMcpServers = [...new Set([...this.status.disabledMcpServers, ...exposed.map((s) => s.name)])];
        await this.stopProcess();
        await this.spawnLocked(command);
      }
      await this.verifyLockdown();
    } catch (err) {
      await this.stopProcess();
      if (this.status.state === "starting") this.status.state = "error";
      this.status.lastError = (err as Error).message;
      throw err;
    }
    this.loadedThreads.clear();
    this.generationCounter++;
    this.status.state = "ready";
    this.status.restricted = true;
    this.options.logger?.info({ version: this.status.cliVersion, auth: this.status.auth?.mode, disabledMcp: this.status.disabledMcpServers.length }, "codex app-server ready");
  }

  private async spawnProcess(command: CodexCommand, extraArgs: string[]): Promise<void> {
    const args = [...command.prefixArgs, "app-server", "--listen", "stdio://", ...extraArgs];
    if (args.some((a) => FORBIDDEN_ARGS.some((f) => a.includes(f)))) throw new LouError("POLICY_DENIED", "Refusing to start Codex with unsafe arguments.");
    const child = spawn(command.file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      cwd: this.options.workspaceDir,
      env: { ...(this.options.env ?? process.env) },
    });
    this.child = child;
    this.stdoutBuffer = "";
    process.once("exit", this.killOnExit);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(child, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep a bounded tail for diagnostics; never log it wholesale.
      this.stderrTail = (this.stderrTail + chunk).slice(-16_384);
    });
    child.on("error", (err) => {
      this.status.lastError = err.message;
      this.options.logger?.error({ err: err.message }, "codex app-server spawn error");
    });
    child.on("exit", (code, signal) => this.onChildExit(child, code, signal));

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", (err) => rejectSpawn(new LouError("NOT_CONFIGURED", `Couldn't start Codex: ${err.message}`)));
    });
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    process.off("exit", this.killOnExit);
    child.stdin.end();
    child.kill();
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
  }

  private async initialize(): Promise<void> {
    const init = await this.rawRequest<InitializeResponse>(
      "initialize",
      { clientInfo: { name: "lou", title: "Lou", version: this.options.clientVersion }, capabilities: { experimentalApi: true, requestAttestation: false } },
      { timeoutMs: 30_000 },
    );
    this.status.codexHome = init.codexHome;
    this.write({ method: "initialized" });
  }

  private async checkAuth(): Promise<boolean> {
    const res = await this.rawRequest<GetAccountResponse>("account/read", { refreshToken: false }, { timeoutMs: 30_000 });
    const account = res.account;
    this.status.auth = account
      ? { mode: account.type === "chatgpt" ? "chatgpt" : account.type === "apiKey" ? "apiKey" : "bedrock", plan: account.type === "chatgpt" ? account.planType : null }
      : null;
    this.status.signedIn = !!account || !res.requiresOpenaiAuth;
    if (!this.status.signedIn) {
      this.status.state = "not_signed_in";
      this.status.lastError = "Not signed in. Run: codex login";
    }
    return this.status.signedIn;
  }

  private appServerMissingError(): LouError {
    this.status.state = "error";
    this.status.lastError = `Codex ${this.status.cliVersion ?? ""} has no App Server. Update it: npm install -g @openai/codex@latest`.replace("  ", " ");
    return new LouError("NOT_CONFIGURED", `This Codex CLI version has no App Server, which Lou needs to keep actions behind its own tools and approvals. Update it with: npm install -g @openai/codex@latest`);
  }

  /** False when the installed CLI lacks `app-server` (then only the `codex exec` fallback is usable). */
  get supportsAppServer(): boolean | undefined {
    return this.appServerSupported;
  }

  /** Launch details for the `codex exec` compatibility fallback (single-shot, tool-less tasks only). */
  execFallback(): { command: CodexCommand; workspaceDir: string; featureArgs: string[]; env?: NodeJS.ProcessEnv } | undefined {
    if (!this.command) return undefined;
    const core = ["shell_tool", "unified_exec", "view_image"].flatMap((f) => ["--disable", f]);
    return { command: this.command, workspaceDir: this.options.workspaceDir, featureArgs: [...core, "-c", "project_doc_max_bytes=0"], env: this.options.env };
  }

  private async computeFeatureLockdown(): Promise<string[]> {
    const args: string[] = [];
    const features = await this.rawRequest<{ data?: Array<{ name: string }> }>("experimentalFeature/list", {}, { timeoutMs: 30_000 }).catch(() => ({ data: [] }));
    const known = new Set((features.data ?? []).map((f) => f.name));
    // If the listing is unavailable, fall back to the core capabilities every version has.
    const toDisable = known.size ? LOCKDOWN_FEATURES.filter((f) => known.has(f)) : ["shell_tool", "unified_exec", "view_image"];
    for (const f of toDisable) args.push("--disable", f);
    for (const f of REQUIRED_FEATURES) if (known.has(f)) args.push("--enable", f);
    // Keep the user's personal Codex AGENTS.md / project docs out of Lou's prompt.
    args.push("-c", "project_doc_max_bytes=0");
    return args;
  }

  /** Launches with feature lockdown plus any MCP servers known to need disabling, then initializes. */
  private async spawnLocked(command: CodexCommand): Promise<void> {
    const mcpArgs = this.status.disabledMcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
    await this.spawnProcess(command, [...(this.lockdownArgs ?? []), ...mcpArgs]);
    await this.initialize();
    if (!(await this.checkAuth())) throw new LouError("NOT_CONFIGURED", "Codex CLI isn't signed in. Run: codex login");
  }

  private async listMcpServers(): Promise<McpServerStatus[]> {
    try {
      const res = await this.rawRequest<{ data?: McpServerStatus[] }>("mcpServerStatus/list", {}, { timeoutMs: 60_000 });
      return res.data ?? [];
    } catch {
      return [];
    }
  }

  /** Refuses to run if any MCP server still exposes tools after lockdown. */
  private async verifyLockdown(): Promise<void> {
    const servers = await this.listMcpServers();
    const exposed = servers.filter((s) => Object.keys(s.tools ?? {}).length > 0);
    if (exposed.length) {
      this.status.state = "error";
      throw new LouError("POLICY_DENIED", `Codex MCP servers could not be disabled (${exposed.map((s) => s.name).join(", ")}).`);
    }
  }

  private rawRequest<T>(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new LouError("UPSTREAM_ERROR", "Codex isn't running."));
    const id = this.nextId++;
    return new Promise<T>((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new LouError("TIMEOUT", `Codex didn't answer ${method} in time.`));
      }, options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve: resolveReq as (v: unknown) => void, reject: rejectReq, timer });
      options.signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          rejectReq(new LouError("CANCELLED", "Cancelled."));
        },
        { once: true },
      );
      this.write({ id, method, params });
    });
  }

  private write(message: object): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (child !== this.child) return;
    this.stdoutBuffer += chunk;
    const max = this.options.maxLineBytes ?? 16 * 1024 * 1024;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
    if (this.stdoutBuffer.length > max) {
      this.options.logger?.error({ bytes: this.stdoutBuffer.length }, "codex app-server produced an oversized line; restarting");
      this.stdoutBuffer = "";
      child.kill();
    }
  }

  private onLine(line: string): void {
    let msg: RpcResponse & RpcServerRequest & RpcNotification;
    try {
      msg = JSON.parse(line);
    } catch {
      this.options.logger?.debug?.({}, "ignored non-JSON line from codex");
      return;
    }
    if (msg.id !== undefined && msg.method) {
      void this.onServerRequest(msg);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new LouError("UPSTREAM_ERROR", `Codex: ${msg.error.message}`, { details: { rpcCode: msg.error.code } }));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) for (const h of this.notificationHandlers) h({ method: msg.method, params: msg.params });
  }

  private async onServerRequest(msg: RpcServerRequest): Promise<void> {
    const respond = (result: unknown) => this.write({ id: msg.id, result });
    const fail = (message: string) => this.write({ id: msg.id, error: { code: -32000, message } });
    try {
      if (msg.method === "item/tool/call" && this.toolCallHandler) {
        respond(await this.toolCallHandler(msg.params as DynamicToolCallParams));
      } else if (CODEX_APPROVAL_REQUESTS.has(msg.method)) {
        // Codex-native actions are never approved; Lou's own approval flow governs real actions.
        this.options.logger?.warn({ method: msg.method }, "declined codex-native approval request");
        if (msg.method === "applyPatchApproval" || msg.method === "execCommandApproval") respond({ decision: { denied: { rejection: "Not available in Lou. Use the provided tools." } } });
        else if (msg.method === "item/permissions/requestApproval") fail("Permission requests are not available in Lou.");
        else respond({ decision: "decline" });
      } else if (msg.method === "mcpServer/elicitation/request") {
        respond({ action: "decline", content: null });
      } else {
        fail(`Unsupported request ${msg.method}`);
      }
    } catch (err) {
      fail((err as Error).message);
    }
  }

  private onChildExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return; // a process we already replaced/stopped
    this.child = undefined;
    process.off("exit", this.killOnExit);
    this.loadedThreads.clear();
    if (this.stopping) return;
    const reason = `Codex stopped unexpectedly (${signal ?? `exit ${code}`}).`;
    this.status.state = "crashed";
    this.status.lastError = reason;
    this.options.logger?.warn({ code, signal, stderr: redact(this.stderrTail.slice(-2000)) }, "codex app-server exited");
    this.failPending(new LouError("UPSTREAM_ERROR", reason, { retryable: true }));
    for (const h of this.exitHandlers) h(reason);
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Bounded backoff between restarts: 1 s, 2 s, 4 s … up to 30 s; refuses past the budget. */
  private async waitForRestartBudget(): Promise<void> {
    if (this.status.state !== "crashed") return;
    const now = Date.now();
    const window = this.options.restartWindowMs ?? 5 * 60_000;
    while (this.restartTimes.length && this.restartTimes[0]! < now - window) this.restartTimes.shift();
    if (this.restartTimes.length >= (this.options.maxRestarts ?? 5)) {
      throw new LouError("UPSTREAM_ERROR", "Codex keeps crashing; giving it a few minutes before trying again.");
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.restartTimes.length);
    this.restartTimes.push(now);
    this.status.restarts++;
    await new Promise((r) => setTimeout(r, delay));
  }
}

function redact(text: string): string {
  return text.replace(/(eyJ[\w-]{10,}\.[\w-]+\.[\w-]+|sk-[\w-]{16,}|Bearer\s+\S+)/g, "[redacted]");
}
