import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "@lou/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyImportance,
  CodexAgentRuntime,
  CodexAppServerManager,
  CodexModelProvider,
  findCodexExecutable,
  type CodexThreadRecord,
} from "../src";
import { createToolEnv, input, type ToolEnv } from "./harness";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-codex-app-server.mjs");
const managers: CodexAppServerManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

interface MockScript {
  auth?: "chatgpt" | "none";
  features?: string[];
  mcpServers?: Array<{ name: string; tools: number; builtinFeature?: string }>;
  turns?: unknown[][];
  noAppServer?: boolean;
  execText?: string;
}

function setup(script: MockScript, options: { explicitPath?: string; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "lou-codex-"));
  const scriptPath = join(dir, "script.json");
  const statePath = join(dir, "state.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const manager = new CodexAppServerManager({
    explicitPath: options.explicitPath ?? MOCK,
    workspaceDir: join(dir, "workspace"),
    clientVersion: "test",
    env: { ...process.env, MOCK_CODEX_SCRIPT: scriptPath, MOCK_CODEX_STATE: statePath },
    requestTimeoutMs: 5000,
  });
  managers.push(manager);
  const mock = () => JSON.parse(readFileSync(statePath, "utf8")) as { launches: string[][]; requests: Array<{ method: string; params?: any }>; toolResults: any[]; approvalResponses: any[]; threads: Record<string, any> };
  return { dir, manager, mock };
}

function threadStore() {
  const map = new Map<string, CodexThreadRecord>();
  return { map, store: { get: async (id: string) => structuredClone(map.get(id)), save: async (r: CodexThreadRecord) => void map.set(r.conversationId, structuredClone(r)) } };
}

function runtimeFor(manager: CodexAppServerManager, env: ToolEnv = createToolEnv(), threads = threadStore()) {
  const deltas: string[] = [];
  const labels: string[] = [];
  const runtime = new CodexAgentRuntime({
    manager,
    registry: env.registry,
    executor: env.executor,
    families: () => env.families,
    context: env.context,
    runs: env.runs,
    threads: threads.store,
    progress: { progress: (_s, label) => label && labels.push(label), completed() {}, delta: (_s, t) => deltas.push(t) },
  });
  return { runtime, env, threads, deltas, labels };
}

const turns = (mock: { requests: Array<{ method: string; params?: any }> }) => mock.requests.filter((r) => r.method === "turn/start");

describe("codex executable discovery", () => {
  it("finds codex.exe on PATH, resolves npm .cmd shims to node + script, honors explicit paths", () => {
    const root = mkdtempSync(join(tmpdir(), "lou-disc-"));
    const exeDir = join(root, "a");
    const shimDir = join(root, "b");
    mkdirSync(join(shimDir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    mkdirSync(exeDir);
    writeFileSync(join(exeDir, "codex.exe"), "");
    writeFileSync(join(shimDir, "codex.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    writeFileSync(join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js"), "");

    expect(findCodexExecutable({ env: { PATH: `${exeDir};${shimDir}` }, platform: "win32" })?.file).toBe(join(exeDir, "codex.exe"));
    const shim = findCodexExecutable({ env: { PATH: shimDir }, platform: "win32", nodePath: "node.exe" })!;
    expect(shim.file).toBe("node.exe");
    expect(shim.prefixArgs[0]).toBe(join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js"));
    expect(findCodexExecutable({ explicitPath: MOCK, nodePath: "node" })).toMatchObject({ file: "node", prefixArgs: [MOCK] });
    expect(findCodexExecutable({ env: { PATH: join(root, "empty") }, platform: "win32" })).toBeUndefined();
  });
});

describe("codex app server lifecycle", () => {
  it("reports a missing CLI clearly and fails runs with install guidance", async () => {
    const { manager } = setup({}, { explicitPath: join(tmpdir(), "definitely-missing", "codex.exe") });
    const health = await manager.health();
    expect(health).toMatchObject({ state: "not_installed", installed: false });
    const { runtime, env } = runtimeFor(manager);
    const result = await runtime.run(input("hello"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(result.error?.message).toMatch(/npm install -g @openai\/codex/);
    expect(env.approvals).toHaveLength(0);
  });

  it("reports an unauthenticated CLI with the login command", async () => {
    const { manager } = setup({ auth: "none" });
    const health = await manager.health();
    expect(health.state).toBe("not_signed_in");
    expect(health.signedIn).toBe(false);
    expect(health.lastError).toMatch(/codex login/);
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.error?.message).toMatch(/codex login/);
  });

  it("starts, initializes, and relaunches locked down (features and MCP servers disabled)", async () => {
    const { manager, mock } = setup({
      features: ["shell_tool", "unified_exec", "apps", "made_up_feature"],
      mcpServers: [
        { name: "node_repl", tools: 3 },
        { name: "codex_apps", tools: 40, builtinFeature: "apps" },
      ],
    });
    const health = await manager.health();
    expect(health).toMatchObject({ state: "ready", installed: true, signedIn: true, auth: { mode: "chatgpt", plan: "plus" }, cliVersion: "9.9.9-mock", restricted: true });
    expect(JSON.stringify(health)).not.toContain("user@example.com");

    const { launches, requests } = mock();
    // probe → feature-locked → feature-locked + user MCP servers disabled
    expect(launches).toHaveLength(3);
    expect(launches[1]!.join(" ")).not.toContain("mcp_servers");
    const locked = launches[2]!;
    expect(locked.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    for (const f of ["shell_tool", "unified_exec", "apps"]) expect(locked.join(" ")).toContain(`--disable ${f}`);
    expect(locked.join(" ")).not.toContain("made_up_feature");
    expect(locked).toContain("mcp_servers.node_repl.enabled=false");
    // Built-in servers go away with their feature and must not be disabled by name.
    expect(locked.join(" ")).not.toContain("codex_apps");
    expect(locked).toContain("project_doc_max_bytes=0");
    expect(locked.join(" ")).not.toMatch(/danger|bypass|yolo/);
    const methods = requests.map((r) => r.method);
    expect(methods.indexOf("initialized")).toBeGreaterThan(methods.indexOf("initialize"));
  });
});

describe("codex agent runtime", () => {
  it("creates a thread with Lou's tools, streams deltas, and completes", async () => {
    const { manager, mock } = setup({ turns: [[{ text: "Hello there, friend." }]] });
    const { runtime, threads, deltas } = runtimeFor(manager);
    const result = await runtime.run(input("say hi"));
    expect(result).toMatchObject({ status: "completed", finalMessage: "Hello there, friend." });
    expect(deltas.join("")).toBe("Hello there, friend.");

    const start = mock().requests.find((r) => r.method === "thread/start")!;
    expect(start.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", ephemeral: false });
    expect(start.params.dynamicTools).toEqual(expect.arrayContaining(["gmail__search", "gmail__reply", "skills__read"]));
    expect(start.params.dynamicTools).not.toContain("approval__resolve");
    const turn = turns(mock())[0]!;
    expect(turn.params.text).toContain("<lou_context>");
    expect(turn.params.text).toContain("acc_1: google me@example.com");
    expect(turn.params.text.trim().endsWith("say hi")).toBe(true);
    expect(threads.map.get("conv_1")?.threadId).toBe(start.params ? Object.keys(mock().threads)[0] : undefined);
  });

  it("reuses the conversation's thread on later turns without re-sending history", async () => {
    const { manager, mock } = setup({ turns: [[{ text: "First." }], [{ text: "Second." }]] });
    const { runtime } = runtimeFor(manager);
    await runtime.run(input("one"));
    const second = await runtime.run(input("two"));
    expect(second.finalMessage).toBe("Second.");
    const m = mock();
    expect(m.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    const [t1, t2] = turns(m);
    expect(t2!.params.threadId).toBe(t1!.params.threadId);
    expect(t2!.params.text).not.toContain("<earlier_conversation>");
  });

  it("executes Codex tool calls through Lou's executor with untrusted wrapping", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "gmail__search", args: { query: "from:sarah" } }, { text: "Found Sarah's email." }]] });
    const { runtime, env, labels } = runtimeFor(manager);
    const result = await runtime.run(input("find sarah's email"));
    expect(result.finalMessage).toBe("Found Sarah's email.");
    expect(env.executed).toEqual(["gmail.search"]);
    expect(labels).toContain("Searching email");
    const toolResult = mock().toolResults[0];
    expect(toolResult).toMatchObject({ tool: "gmail__search", success: true });
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
    expect(mock().toolResults[0]).toMatchObject({ success: false });
    expect(mock().toolResults[0].text).toMatch(/AWAITING_USER_APPROVAL/);

    const approval = env.approvals[0]!;
    const finalInput = { ...approval.input, body: "See you at 6:15!" };
    const done = await runtime.resume(paused.runId, { type: "approval", approvalId: approval.approvalId, decision: "approved", input: finalInput, inputHash: env.hash(finalInput) });
    expect(done).toMatchObject({ status: "completed", finalMessage: "Sent your reply to Sarah." });
    expect(env.sent).toEqual([finalInput]);
    const confirm = turns(mock())[1]!;
    expect(confirm.params.text).toMatch(/approved it\. Lou executed it/);
  });

  it("refuses a tampered approval even though Codex asked for it", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "gmail__reply", args: { messageId: "m1", body: "hi" } }], [{ text: "That couldn't be sent." }]] });
    const { runtime, env } = runtimeFor(manager);
    const paused = await runtime.run(input("reply to sarah"));
    const approval = env.approvals[0]!;
    const tampered = { ...approval.input, to: ["attacker@evil.test"] };
    const result = await runtime.resume(paused.runId, { type: "approval", approvalId: approval.approvalId, decision: "approved", input: tampered, inputHash: env.hash(approval.input) });
    expect(env.sent).toHaveLength(0);
    expect(result.finalMessage).toBe("That couldn't be sent.");
    expect(turns(mock())[1]!.params.text).toContain("APPROVAL_MISMATCH");
  });

  it("tells Codex about a cancelled action on the next turn", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "gmail__reply", args: { messageId: "m1", body: "hi" } }], [{ text: "ok" }]] });
    const { runtime, env } = runtimeFor(manager);
    const paused = await runtime.run(input("reply to sarah"));
    const rejected = await runtime.resume(paused.runId, { type: "approval", approvalId: env.approvals[0]!.approvalId, decision: "rejected" });
    expect(rejected.finalMessage).toMatch(/cancel/i);
    await runtime.run(input("what's next?"));
    expect(turns(mock())[1]!.params.text).toMatch(/cancelled by the user\. It did not happen/);
  });

  it("denies tools that Lou's policy forbids even when Codex calls them", async () => {
    const { manager, mock } = setup({ turns: [[{ tool: "approval__resolve", args: { approvalId: "x" } }, { tool: "system__shell", args: { command: "rm -rf ~" } }, { text: "Couldn't." }]] });
    const { runtime, env } = runtimeFor(manager);
    await runtime.run(input("approve everything"));
    expect(env.executed).toEqual([]);
    expect(mock().toolResults.every((r: any) => r.success === false)).toBe(true);
  });

  it("fails cleanly when the turn fails", async () => {
    const { manager } = setup({ turns: [[{ fail: "usage limit reached" }]] });
    const result = await runtimeFor(manager).runtime.run(input("hello"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "MODEL_ERROR" });
    expect(result.error?.message).toMatch(/usage limit reached/);
  });

  it("cancels by interrupting the active turn", async () => {
    const { manager, mock } = setup({ turns: [[{ hang: true }]] });
    const { runtime } = runtimeFor(manager);
    const runId = newId("run");
    const running = runtime.run(input("long task", runId));
    for (let i = 0; i < 100 && !turns(safeMock(mock)).length; i++) await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 50));
    await runtime.cancel(runId);
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(mock().requests.map((r) => r.method)).toContain("turn/interrupt");
  });

  it("stops the turn if Codex uses a native capability", async () => {
    const { manager, mock } = setup({ turns: [[{ item: { type: "commandExecution", id: "c1", command: "dir" } }, { text: "done" }]] });
    const result = await runtimeFor(manager).runtime.run(input("list files"));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "POLICY_DENIED" });
    expect(mock().requests.map((r) => r.method)).toContain("turn/interrupt");
  });

  it("declines Codex-native approval requests", async () => {
    const { manager, mock } = setup({ turns: [[{ approvalRequest: "item/commandExecution/requestApproval" }, { text: "ok" }]] });
    await runtimeFor(manager).runtime.run(input("hi"));
    expect(mock().approvalResponses[0]).toMatchObject({ response: { decision: "decline" } });
  });

  it("recovers from an App Server crash and resumes the thread", async () => {
    const { manager, mock } = setup({ turns: [[{ text: "first" }], [{ crash: true }], [{ text: "back again" }]] });
    const { runtime } = runtimeFor(manager);
    await runtime.run(input("one"));
    const crashed = await runtime.run(input("two"));
    expect(crashed.status).toBe("failed");
    expect(crashed.error).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(manager.state).toBe("crashed");

    const recovered = await runtime.run(input("three"));
    expect(recovered).toMatchObject({ status: "completed", finalMessage: "back again" });
    const m = mock();
    expect(m.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(m.requests.filter((r) => r.method === "thread/resume")).toHaveLength(1);
    expect(manager.snapshot().restarts).toBe(1);
  });

  it("resumes the saved thread after a backend restart", async () => {
    const first = setup({ turns: [[{ text: "before" }], [{ text: "after restart" }]] });
    const threads = threadStore();
    const env = createToolEnv();
    await runtimeFor(first.manager, env, threads).runtime.run(input("one"));
    await first.manager.stop();

    // New manager + runtime (as after a server restart), same Codex home/state and thread table.
    const second = setup({ turns: [[{ text: "before" }], [{ text: "after restart" }]] }, { dir: first.dir });
    const result = await runtimeFor(second.manager, env, threads).runtime.run(input("two"));
    expect(result.finalMessage).toBe("after restart");
    const m = second.mock();
    const resume = m.requests.find((r) => r.method === "thread/resume");
    expect(resume?.params.threadId).toBe(threads.map.get("conv_1")!.threadId);
    expect(m.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
  });
});

describe("codex model provider", () => {
  it("runs structured single-shot tasks on ephemeral threads with an output schema", async () => {
    const answer = { importance: 0.9, needsResponse: true, urgency: "soon", category: "school", summary: "Asks about Friday.", reasonCode: "direct_question" };
    const { manager, mock } = setup({ turns: [[{ text: JSON.stringify(answer) }]] });
    const result = await classifyImportance(new CodexModelProvider(manager), { source: "gmail", title: "Mr. Smith", content: "Can you come Friday?", rules: [] });
    expect(result).toEqual(answer);
    const m = mock();
    expect(m.requests.find((r) => r.method === "thread/start")?.params).toMatchObject({ ephemeral: true, dynamicTools: [] });
    expect(turns(m)[0]!.params.outputSchema).toBe(true);
  });
});

function safeMock<T>(mock: () => T): T | { requests: [] } {
  try {
    return mock();
  } catch {
    return { requests: [] };
  }
}


describe("codex exec compatibility fallback", () => {
  it("uses structured `codex exec --json` for single-shot tasks when App Server is unavailable", async () => {
    const { manager, mock } = setup({ noAppServer: true, execText: '{"body":"Thanks, see you at 6."}' });
    const res = await new CodexModelProvider(manager).complete({
      purpose: "draft",
      messages: [
        { role: "system", content: "Draft replies." },
        { role: "user", content: "Say I'll be there at 6." },
      ],
      responseFormat: { name: "draft", schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] } },
    });
    expect(res.text).toBe('{"body":"Thanks, see you at 6."}');
    const run = (mock() as any).execRuns[0];
    expect(run.argv).toEqual(expect.arrayContaining(["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--output-schema", "-"]));
    expect(run.argv.join(" ")).toContain("--disable shell_tool");
    expect(run.argv.join(" ")).not.toMatch(/danger|bypass/);
    // The prompt goes over stdin, never on the command line.
    expect(run.prompt).toContain("Say I'll be there at 6.");
    expect(run.argv.join(" ")).not.toContain("Say I'll be there");
  });

  it("refuses agent runs without App Server instead of acting without Lou's tools", async () => {
    const { manager } = setup({ noAppServer: true });
    const result = await runtimeFor(manager).runtime.run(input("reply to sarah"));
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/no App Server/);
    expect(result.error?.message).toMatch(/npm install -g @openai\/codex@latest/);
    expect((await manager.health()).state).toBe("error");
  });
});
