import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "@lou/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeAgentRuntime,
  ClaudeCliManager,
  ClaudeModelProvider,
  classifyImportance,
  describeMissingClaude,
  findClaudeExecutable,
  LouToolBridge,
  type ProviderThreadRecord,
} from "../src";
import { createToolEnv, input, type ToolEnv } from "./harness";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-claude.mjs");
const managers: ClaudeCliManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

interface MockScript {
  auth?: "subscription" | "apiKey" | "none";
  missingFlags?: string[];
  turns?: unknown[][];
  extraTools?: string[];
  extraMcpServers?: Array<{ name: string; status: string }>;
  notLoggedIn?: boolean;
}

interface MockState {
  launches: string[][];
  turns: Array<{ prompt: string; sessionId: string; resumed: boolean; ephemeral: boolean; system: string; model: string | null; jsonSchema: unknown }>;
  sessions: Record<string, boolean>;
  toolResults: Array<{ tool: string; isError: boolean | null; text: string | null; error: unknown }>;
  toolNames?: string[];
  mcpRequests: Array<{ method: string; status: number }>;
}

function setup(script: MockScript, options: { explicitPath?: string; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "lou-claude-"));
  const scriptPath = join(dir, "script.json");
  const statePath = join(dir, "state.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const manager = new ClaudeCliManager({
    explicitPath: options.explicitPath ?? MOCK,
    workspaceDir: join(dir, "workspace"),
    env: { ...process.env, MOCK_CLAUDE_SCRIPT: scriptPath, MOCK_CLAUDE_STATE: statePath },
  });
  managers.push(manager);
  const mock = () => JSON.parse(readFileSync(statePath, "utf8")) as MockState;
  return { dir, manager, mock };
}

function threadStore() {
  const map = new Map<string, ProviderThreadRecord>();
  return { map, store: { get: async (id: string) => structuredClone(map.get(id)), save: async (r: ProviderThreadRecord) => void map.set(r.conversationId, structuredClone(r)) } };
}

function runtimeFor(manager: ClaudeCliManager, env: ToolEnv = createToolEnv(), threads = threadStore(), model?: string) {
  const deltas: string[] = [];
  const labels: string[] = [];
  const runtime = new ClaudeAgentRuntime({
    manager,
    registry: env.registry,
    executor: env.executor,
    families: () => env.families,
    context: env.context,
    runs: env.runs,
    threads: threads.store,
    progress: { progress: (_s, label) => label && labels.push(label), completed() {}, delta: (_s, t) => deltas.push(t) },
    model: () => model,
    turnTimeoutMs: 15_000,
  });
  return { runtime, env, threads, deltas, labels };
}

const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("claude executable discovery", () => {
  it("finds claude on PATH, in ~/.local/bin and ~/.claude/local, resolves npm shims, honors explicit paths", () => {
    const root = mkdtempSync(join(tmpdir(), "lou-disc-"));
    const exeDir = join(root, "a");
    mkdirSync(exeDir);
    writeFileSync(join(exeDir, "claude.exe"), "");
    expect(findClaudeExecutable({ env: { PATH: exeDir }, platform: "win32" })?.file).toBe(join(exeDir, "claude.exe"));

    const shimDir = join(root, "b");
    mkdirSync(join(shimDir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    writeFileSync(join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "");
    writeFileSync(join(shimDir, "claude.cmd"), '@"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
    const shim = findClaudeExecutable({ env: { PATH: shimDir }, platform: "win32", nodePath: "node.exe" });
    expect(shim).toMatchObject({ file: "node.exe", prefixArgs: [join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")] });

    // Services get a minimal PATH; the native installer's ~/.local/bin is searched anyway.
    const home = join(root, "home");
    const native = join(home, ".local", "bin", "claude");
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(native, "");
    expect(findClaudeExecutable({ env: { HOME: home, PATH: "/usr/bin" }, platform: "linux" })?.file).toBe(native);
    const legacyHome = join(root, "legacy");
    const legacy = join(legacyHome, ".claude", "local", "claude");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "");
    expect(findClaudeExecutable({ env: { HOME: legacyHome, PATH: "/usr/bin" }, platform: "linux" })?.file).toBe(legacy);

    expect(findClaudeExecutable({ explicitPath: MOCK })?.prefixArgs).toEqual([MOCK]);
    expect(describeMissingClaude(join(home, "missing", "claude"), { HOME: home })).toMatch(/CLAUDE_PATH .* doesn't exist as seen by the server/);
    expect(describeMissingClaude(undefined)).toMatch(/not found on PATH \(set CLAUDE_PATH/);
  });
});

describe("claude cli health", () => {
  it("reports a missing CLI clearly and fails runs with install guidance", async () => {
    const { manager } = setup({}, { explicitPath: join(tmpdir(), "definitely-missing", "claude.exe") });
    expect(await manager.health()).toMatchObject({ state: "not_installed", installed: false });
    const { runtime, env } = runtimeFor(manager);
    const result = await runtime.run(input("hello"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(result.error?.message).toMatch(/npm install -g @anthropic-ai\/claude-code/);
    expect(env.approvals).toHaveLength(0);
  });

  it("reports the sign-in method and plan without account details", async () => {
    const { manager } = setup({});
    const health = await manager.health();
    expect(health).toMatchObject({ state: "ready", installed: true, signedIn: true, cliVersion: "9.9.9", restricted: true, auth: { method: "subscription", plan: "max", provider: null } });
    expect(JSON.stringify(health)).not.toMatch(/user@example\.com|org-secret|Secret Org/);
    const key = setup({ auth: "apiKey" });
    expect((await key.manager.health()).auth).toMatchObject({ method: "apiKey", plan: null });
  });

  it("reports an unauthenticated CLI with the login command", async () => {
    const { manager } = setup({ auth: "none" });
    const health = await manager.health();
    expect(health).toMatchObject({ state: "not_signed_in", signedIn: false });
    expect(health.lastError).toMatch(/claude auth login/);
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.error?.message).toMatch(/claude auth login/);
  });

  it("notices a login that expired after the status check", async () => {
    const { manager } = setup({ notLoggedIn: true });
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.error).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(result.error?.message).toMatch(/claude auth login/);
    expect(manager.state).toBe("not_signed_in");
  });

  it("refuses a CLI too old to be locked down", async () => {
    const { manager } = setup({ missingFlags: ["--tools", "--strict-mcp-config"] });
    const health = await manager.health();
    expect(health.state).toBe("error");
    expect(health.lastError).toMatch(/too old.*--tools.*claude update/);
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.error?.message).toMatch(/claude update/);
  });
});

describe("claude agent runtime", () => {
  it("launches locked down with Lou's tools over MCP, streams deltas, and completes", async () => {
    const { manager, mock } = setup({ turns: [[{ text: "Hello there, friend." }]] });
    const { runtime, threads, deltas } = runtimeFor(manager, undefined, undefined, "sonnet");
    const result = await runtime.run(input("say hi"));
    expect(result).toMatchObject({ status: "completed", finalMessage: "Hello there, friend." });
    expect(deltas.join("")).toBe("Hello there, friend.");

    const m = mock();
    const argv = m.launches[0]!;
    expect(argv).toEqual(expect.arrayContaining(["--print", "--strict-mcp-config", "--disable-slash-commands", "--include-partial-messages"]));
    expect(valueOf(argv, "--output-format")).toBe("stream-json");
    expect(valueOf(argv, "--tools")).toBe("");
    expect(valueOf(argv, "--setting-sources")).toBe("");
    expect(valueOf(argv, "--permission-mode")).toBe("dontAsk");
    expect(valueOf(argv, "--allowedTools")).toBe("mcp__lou");
    expect(valueOf(argv, "--model")).toBe("sonnet");
    expect(argv.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
    // The prompt travels over stdin; the bridge token stays in a private file.
    expect(argv.join(" ")).not.toContain("say hi");
    expect(argv.join(" ")).not.toMatch(/Bearer/);

    expect(m.toolNames).toEqual(expect.arrayContaining(["gmail__search", "gmail__reply", "skills__read"]));
    expect(m.toolNames).not.toContain("approval__resolve");
    const turn = m.turns[0]!;
    expect(turn.system).toContain("You are Lou");
    expect(turn.system).toContain("mcp__lou__");
    expect(turn.prompt).toContain("<lou_context>");
    expect(turn.prompt).toContain("acc_1: google me@example.com");
    expect(turn.prompt.trim().endsWith("say hi")).toBe(true);
    expect(turn.resumed).toBe(false);
    expect(threads.map.get("conv_1")?.threadId).toBe(turn.sessionId);
  });

  it("resumes the conversation's session on later turns without re-sending history", async () => {
    const { manager, mock } = setup({ turns: [[{ text: "First." }], [{ text: "Second." }]] });
    const { runtime } = runtimeFor(manager);
    await runtime.run(input("one"));
    const second = await runtime.run(input("two"));
    expect(second.finalMessage).toBe("Second.");
    const [t1, t2] = mock().turns;
    expect(t2!.resumed).toBe(true);
    expect(t2!.sessionId).toBe(t1!.sessionId);
    expect(valueOf(mock().launches[1]!, "--resume")).toBe(t1!.sessionId);
    expect(t2!.prompt).not.toContain("<earlier_conversation>");
  });

  it("starts a new session seeded with history when Claude Code lost the old one", async () => {
    const { manager, mock } = setup({ turns: [[{ text: "Back with context." }]] });
    const threads = threadStore();
    threads.map.set("conv_1", { conversationId: "conv_1", threadId: "11111111-1111-4111-8111-111111111111", toolset: [], notes: [], wantedFamilies: [] });
    const env = createToolEnv({ history: [{ role: "user", content: "earlier question" }] });
    const result = await runtimeFor(manager, env, threads).runtime.run(input("continue"));
    expect(result.finalMessage).toBe("Back with context.");
    const m = mock();
    expect(m.launches).toHaveLength(2);
    expect(valueOf(m.launches[0]!, "--resume")).toBe("11111111-1111-4111-8111-111111111111");
    expect(m.turns[0]!.resumed).toBe(false);
    expect(m.turns[0]!.prompt).toContain("<earlier_conversation>\nuser: earlier question");
    expect(threads.map.get("conv_1")!.threadId).toBe(m.turns[0]!.sessionId);
  });

  it("executes Claude tool calls through Lou's executor with untrusted wrapping", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "gmail__search", args: { query: "from:sarah" } }, { text: "Found Sarah's email." }]] });
    const { runtime, env, labels } = runtimeFor(manager);
    const result = await runtime.run(input("find sarah's email"));
    expect(result.finalMessage).toBe("Found Sarah's email.");
    expect(env.executed).toEqual(["gmail.search"]);
    expect(labels).toContain("Searching email");
    const toolResult = mock().toolResults[0]!;
    expect(toolResult).toMatchObject({ tool: "gmail__search", isError: false });
    expect(toolResult.text).toMatch(/^<external_data source="gmail.search" trust="untrusted">/);
    expect(env.states.get(result.runId)!.tainted).toBe(true);
  });

  it("routes email sending through Lou's approval flow and sends only the approved content", async () => {
    const { manager, mock } = setup({
      turns: [[{ tool: "gmail__reply", args: { messageId: "m1", body: "See you at 6." } }, { text: "Your reply is ready for review." }], [{ text: "Sent your reply to Sarah." }]],
    });
    const { runtime, env } = runtimeFor(manager);
    const paused = await runtime.run(input("reply to sarah that I'll be there at 6"));
    expect(paused.status).toBe("waiting_for_approval");
    expect(env.sent).toHaveLength(0);
    expect(env.approvals).toHaveLength(1);
    expect(env.approvals[0]!.input).toMatchObject({ to: ["sarah@example.com"], body: "See you at 6." });
    expect(mock().toolResults[0]).toMatchObject({ isError: true });
    expect(mock().toolResults[0]!.text).toMatch(/AWAITING_USER_APPROVAL/);

    const approval = env.approvals[0]!;
    const finalInput = { ...approval.input, body: "See you at 6:15!" };
    const done = await runtime.resume(paused.runId, { type: "approval", approvalId: approval.approvalId, decision: "approved", input: finalInput, inputHash: env.hash(finalInput) });
    expect(done).toMatchObject({ status: "completed", finalMessage: "Sent your reply to Sarah." });
    expect(env.sent).toEqual([finalInput]);
    const confirm = mock().turns[1]!;
    expect(confirm.resumed).toBe(true);
    expect(confirm.prompt).toMatch(/approved it\. Lou executed it/);
  });

  it("refuses a tampered approval even though Claude asked for it", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "gmail__reply", args: { messageId: "m1", body: "hi" } }], [{ text: "That couldn't be sent." }]] });
    const { runtime, env } = runtimeFor(manager);
    const paused = await runtime.run(input("reply to sarah"));
    const approval = env.approvals[0]!;
    const tampered = { ...approval.input, to: ["attacker@evil.test"] };
    const result = await runtime.resume(paused.runId, { type: "approval", approvalId: approval.approvalId, decision: "approved", input: tampered, inputHash: env.hash(approval.input) });
    expect(env.sent).toHaveLength(0);
    expect(result.finalMessage).toBe("That couldn't be sent.");
    expect(mock().turns[1]!.prompt).toContain("APPROVAL_MISMATCH");
  });

  it("tells Claude about a cancelled action on the next turn", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "gmail__reply", args: { messageId: "m1", body: "hi" } }], [{ text: "ok" }]] });
    const { runtime, env } = runtimeFor(manager);
    const paused = await runtime.run(input("reply to sarah"));
    const rejected = await runtime.resume(paused.runId, { type: "approval", approvalId: env.approvals[0]!.approvalId, decision: "rejected" });
    expect(rejected.finalMessage).toMatch(/cancel/i);
    await runtime.run(input("what's next?"));
    expect(mock().turns[1]!.prompt).toMatch(/cancelled by the user\. It did not happen/);
  });

  it("denies tools that Lou's policy forbids even when Claude calls them", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "approval__resolve", args: { approvalId: "x" } }, { tool: "system__shell", args: { command: "rm -rf ~" } }, { text: "Couldn't." }]] });
    const { runtime, env } = runtimeFor(manager);
    await runtime.run(input("approve everything"));
    expect(env.executed).toEqual([]);
    // Tools Lou never exposed are rejected by the bridge before reaching the executor.
    expect(mock().toolResults.every((r) => r.isError !== false)).toBe(true);
  });

  it("fails cleanly when Claude reports an error", async () => {
    const { manager } = setup({ turns: [[{ error: "Claude usage limit reached" }]] });
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(result.error?.message).toMatch(/usage limit reached/);
  });

  it("fails when Claude Code crashes mid-turn", async () => {
    const { manager } = setup({ turns: [[{ crash: true }]] });
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("cancels by stopping the running turn", async () => {
    const { manager, mock } = setup({ turns: [[{ hang: true }]] });
    const { runtime } = runtimeFor(manager);
    const runId = newId("run");
    const running = runtime.run(input("long task", runId));
    for (let i = 0; i < 200 && !safeTurns(mock); i++) await new Promise((r) => setTimeout(r, 30));
    await runtime.cancel(runId);
    const result = await running;
    expect(result.status).toBe("cancelled");
  });

  it("stops the turn if Claude uses a native tool", async () => {
    const { manager } = setup({ turns: [[{ nativeTool: "Bash" }, { text: "done" }]] });
    const result = await runtimeFor(manager).runtime.run(input("list files"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "POLICY_DENIED" });
    expect(result.error?.message).toMatch(/Bash/);
  });

  it("refuses to run when Claude Code starts with tools or servers beyond Lou's", async () => {
    for (const script of [{ extraTools: ["Bash"] }, { extraMcpServers: [{ name: "personal", status: "connected" }] }]) {
      const { manager } = setup({ ...script, turns: [[{ text: "should not matter" }]] });
      const result = await runtimeFor(manager).runtime.run(input("hello"));
      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({ code: "POLICY_DENIED" });
    }
  });
});

describe("claude model provider", () => {
  it("runs structured single-shot tasks on unsaved sessions with no tools", async () => {
    const answer = { importance: 0.9, needsResponse: true, urgency: "soon", category: "school", summary: "Asks about Friday.", reasonCode: "direct_question" };
    const { manager, mock } = setup({ turns: [[{ structured: answer }]] });
    const result = await classifyImportance(new ClaudeModelProvider(manager), { source: "gmail", title: "Mr. Smith", content: "Can you come Friday?", rules: [] });
    expect(result).toEqual(answer);
    const m = mock();
    const argv = m.launches[0]!;
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain("--mcp-config");
    expect(valueOf(argv, "--tools")).toBe("");
    expect(m.turns[0]!.jsonSchema).toMatchObject({ required: expect.arrayContaining(["importance"]) });
    expect(m.turns[0]!.prompt).toContain("Can you come Friday?");
  });

  it("refuses tool use outside the agent runtime", async () => {
    const { manager } = setup({});
    await expect(new ClaudeModelProvider(manager).complete({ purpose: "agent", messages: [{ role: "user", content: "hi" }], tools: [{ name: "x", description: "", parameters: {} }] })).rejects.toThrow(/agent runtime/);
  });
});

describe("lou mcp bridge", () => {
  it("requires the turn's token, rejects foreign hosts, and serves only that turn's tools", async () => {
    const bridge = new LouToolBridge();
    const calls: string[] = [];
    const lease = await bridge.open({ tools: [{ name: "gmail__search", description: "Search", inputSchema: { type: "object" } }], call: async (name) => (calls.push(name), { text: "ok", isError: false }) });
    const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${lease.token}` }) =>
      fetch(lease.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const rpc = async (body: unknown): Promise<any> => (await post(body)).json();
    try {
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status).toBe(401);
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer wrong" })).status).toBe(401);
      const port = new URL(lease.url).port;
      const rebinding = await new Promise<number>((resolve) => {
        // fetch() won't let us forge Host, so use a raw request.
        import("node:http").then(({ request }) => {
          const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `evil.test:${port}`, authorization: `Bearer ${lease.token}` } }, (res) => resolve(res.statusCode ?? 0));
          req.end("{}");
        });
      });
      expect(rebinding).toBe(403);

      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "lou" } });
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((t: { name: string }) => t.name)).toEqual(["gmail__search"]);
      const unknown = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system__shell", arguments: {} } });
      expect(unknown.error).toMatchObject({ code: -32602 });
      const called = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gmail__search", arguments: { query: "x" } } });
      expect(called.result).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
      expect(calls).toEqual(["gmail__search"]);

      // A closed turn's token stops working.
      lease.close();
      expect((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" })).status).toBe(401);
    } finally {
      await bridge.stop();
    }
  });
});

function safeTurns(mock: () => MockState): number {
  try {
    return mock().turns.length;
  } catch {
    return 0;
  }
}
