#!/usr/bin/env node
// Scriptable stand-in for `codex app-server --listen stdio://` used by tests.
// Speaks the same newline-delimited JSON-RPC. Behaviour comes from a JSON script
// (MOCK_CODEX_SCRIPT); threads, turn counter and a request log persist in a
// state file (MOCK_CODEX_STATE) so restarts and crashes can be simulated.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("codex-cli 9.9.9-mock");
  process.exit(0);
}

const scriptPath = process.env.MOCK_CODEX_SCRIPT;
const statePath = process.env.MOCK_CODEX_STATE;
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : {};
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { threads: {}, turn: 0, launches: [], requests: [], toolResults: [], approvalResponses: [] });
const save = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
const state = load();
state.launches.push(argv);
save(state);

const disabledMcp = new Set(argv.flatMap((a, i) => (argv[i - 1] === "-c" && /^mcp_servers\.(.+)\.enabled=false$/.test(a) ? [a.match(/^mcp_servers\.(.+)\.enabled=false$/)[1]] : [])));
const disabledFeatures = new Set(argv.flatMap((a, i) => (argv[i - 1] === "--disable" ? [a] : [])));
// Like the real CLI: disabling a built-in server by name breaks config loading.
for (const s of script.mcpServers ?? []) {
  if (s.builtinFeature && disabledMcp.has(s.name)) {
    process.stderr.write("Error: invalid transport in mcp_servers." + s.name + "\n");
    process.exit(1);
  }
}
const loaded = new Set();
let nextServerReqId = 1000;
const serverPending = new Map();
let activeTurn = null; // { threadId, turnId, interrupted, wake }

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });
const record = (entry) => {
  const s = load();
  s.requests.push(entry);
  save(s);
};
const callServer = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerReqId++;
    serverPending.set(id, resolve);
    send({ id, method, params });
  });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void onMessage(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

async function onMessage(msg) {
  if (msg.id !== undefined && !msg.method) {
    const resolve = serverPending.get(msg.id);
    serverPending.delete(msg.id);
    resolve?.(msg);
    return;
  }
  if (msg.id === undefined) {
    record({ method: msg.method });
    return;
  }
  const ok = (result) => send({ id: msg.id, result });
  const err = (message) => send({ id: msg.id, error: { code: -32000, message } });
  record({ method: msg.method, params: summarize(msg.method, msg.params) });

  switch (msg.method) {
    case "initialize":
      return ok({ userAgent: "mock", codexHome: "/mock/.codex", platformFamily: "mock", platformOs: "mock" });
    case "account/read":
      return ok(script.auth === "none" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "user@example.com", planType: "plus" }, requiresOpenaiAuth: true });
    case "experimentalFeature/list":
      return ok({ data: (script.features ?? ["shell_tool", "unified_exec", "view_image", "apps", "plugins", "computer_use"]).map((name) => ({ name, enabled: true })) });
    case "mcpServerStatus/list":
      // Built-in servers (e.g. the apps runtime) vanish when their feature is disabled.
      return ok({ data: (script.mcpServers ?? []).filter((s) => !s.builtinFeature || !disabledFeatures.has(s.builtinFeature)).map((s) => ({ name: s.name, tools: disabledMcp.has(s.name) ? {} : Object.fromEntries(Array.from({ length: s.tools }, (_, k) => [`t${k}`, {}])) })) });
    case "thread/start": {
      const s = load();
      const id = `thread_${Object.keys(s.threads).length + 1}_${Date.now() % 100000}`;
      const thread = { id, dynamicTools: (msg.params.dynamicTools ?? []).map((t) => t.name), ephemeral: !!msg.params.ephemeral, baseInstructions: msg.params.baseInstructions ?? null, sandbox: msg.params.sandbox, approvalPolicy: msg.params.approvalPolicy };
      if (!thread.ephemeral) s.threads[id] = thread;
      save(s);
      loaded.add(id);
      return ok({ thread: { id }, model: "mock-model", modelProvider: "openai", cwd: "/w", instructionSources: [], approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } });
    }
    case "thread/resume": {
      const s = load();
      if (!s.threads[msg.params.threadId]) return err("thread not found");
      loaded.add(msg.params.threadId);
      return ok({ thread: { id: msg.params.threadId }, model: "mock-model" });
    }
    case "turn/interrupt":
      if (activeTurn && activeTurn.turnId === msg.params.turnId) {
        activeTurn.interrupted = true;
        activeTurn.wake?.();
      }
      return ok({});
    case "turn/start": {
      const threadId = msg.params.threadId;
      if (!loaded.has(threadId)) return err("thread not loaded");
      const s = load();
      const steps = (script.turns ?? [])[s.turn] ?? [{ text: "ok" }];
      s.turn++;
      save(s);
      const turnId = `turn_${s.turn}`;
      ok({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
      void runTurn(threadId, turnId, steps);
      return;
    }
    default:
      return err(`unsupported ${msg.method}`);
  }
}

async function runTurn(threadId, turnId, steps) {
  activeTurn = { threadId, turnId, interrupted: false };
  const base = { threadId, turnId };
  const finish = (status, error = null, items = []) => {
    activeTurn = null;
    notify("turn/completed", { threadId, turn: { id: turnId, items, status, error } });
  };
  notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null } });
  const items = [];
  for (const step of steps) {
    if (activeTurn?.interrupted) return finish("interrupted");
    if (step.text !== undefined) {
      const itemId = `msg_${Math.random().toString(36).slice(2, 8)}`;
      notify("item/started", { ...base, item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer" } });
      for (const word of step.text.split(/(?<= )/)) notify("item/agentMessage/delta", { ...base, itemId, delta: word });
      const item = { type: "agentMessage", id: itemId, text: step.text, phase: "final_answer" };
      notify("item/completed", { ...base, item });
      items.push(item);
    } else if (step.tool) {
      const callId = `call_${Math.random().toString(36).slice(2, 8)}`;
      notify("item/started", { ...base, item: { type: "dynamicToolCall", id: callId, tool: step.tool, arguments: step.args ?? {}, status: "inProgress" } });
      const res = await callServer("item/tool/call", { threadId, turnId, callId, namespace: null, tool: step.tool, arguments: step.args ?? {} });
      const s = load();
      s.toolResults.push({ tool: step.tool, success: res.result?.success, text: res.result?.contentItems?.[0]?.text ?? null, error: res.error ?? null });
      save(s);
      notify("item/completed", { ...base, item: { type: "dynamicToolCall", id: callId, tool: step.tool, status: "completed", success: res.result?.success } });
    } else if (step.fail) {
      return finish("failed", { message: step.fail, codexErrorInfo: null, additionalDetails: null });
    } else if (step.crash) {
      process.exit(3);
    } else if (step.hang) {
      await new Promise((resolve) => {
        if (activeTurn) activeTurn.wake = resolve;
      });
      return finish("interrupted");
    } else if (step.item) {
      notify("item/started", { ...base, item: step.item });
      await new Promise((resolve) => {
        if (activeTurn) activeTurn.wake = resolve;
        setTimeout(resolve, 2000);
      });
      if (activeTurn?.interrupted) return finish("interrupted");
    } else if (step.approvalRequest) {
      const res = await callServer(step.approvalRequest, { threadId, turnId, itemId: "x", command: "rm -rf /" });
      const s = load();
      s.approvalResponses.push({ method: step.approvalRequest, response: res.result ?? res.error });
      save(s);
    }
  }
  finish("completed", null, items);
}

function summarize(method, params) {
  if (method === "turn/start") return { threadId: params.threadId, text: params.input?.[0]?.text, outputSchema: !!params.outputSchema };
  if (method === "thread/start") return { dynamicTools: (params.dynamicTools ?? []).map((t) => t.name), ephemeral: !!params.ephemeral, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy };
  if (method === "thread/resume") return { threadId: params.threadId };
  return undefined;
}
