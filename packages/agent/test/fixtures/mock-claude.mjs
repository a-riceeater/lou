#!/usr/bin/env node
// Scriptable stand-in for the `claude` CLI used by tests. Supports `--version`,
// `--help`, `auth status --json` and `-p --output-format stream-json`, where it
// reads the prompt from stdin, connects to the MCP servers in --mcp-config over
// real HTTP, and emits stream-json events. Behaviour comes from a JSON script
// (MOCK_CLAUDE_SCRIPT); sessions, the turn counter and a request log persist
// in a state file (MOCK_CLAUDE_STATE).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const script = process.env.MOCK_CLAUDE_SCRIPT ? JSON.parse(readFileSync(process.env.MOCK_CLAUDE_SCRIPT, "utf8")) : {};
const statePath = process.env.MOCK_CLAUDE_STATE;
const load = () => (statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { launches: [], turns: [], sessions: {}, turn: 0, toolResults: [], mcpRequests: [] });
const save = (s) => statePath && writeFileSync(statePath, JSON.stringify(s, null, 2));
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}

if (argv.includes("--help")) {
  const flags = ["--print", "--output-format", "--verbose", "--include-partial-messages", "--tools", "--mcp-config", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands", "--permission-mode", "--system-prompt", "--allowedTools", "--model", "--session-id", "--resume", "--no-session-persistence", "--json-schema"];
  const missing = new Set(script.missingFlags ?? []);
  console.log("Usage: claude [options] [command] [prompt]\n\nOptions:");
  for (const f of flags) if (!missing.has(f)) console.log(`  ${f}  description`);
  console.log('  permission modes (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")');
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = script.auth ?? "subscription";
  const base = { apiProvider: "firstParty", email: "user@example.com", orgId: "org-secret-123", orgName: "Secret Org" };
  if (auth === "none") console.log(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
  else if (auth === "apiKey") console.log(JSON.stringify({ ...base, loggedIn: true, authMethod: "api_key" }));
  else console.log(JSON.stringify({ ...base, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(auth === "none" ? 1 : 0);
}

const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => void main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(5);
}));

async function main() {
  const state = load();
  state.launches.push(argv);
  const resume = value("--resume");
  const ephemeral = argv.includes("--no-session-persistence");
  if (resume && !state.sessions[resume]) {
    save(state);
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }
  const sessionId = resume ?? value("--session-id") ?? randomUUID();
  if (!ephemeral) state.sessions[sessionId] = true;
  const steps = (script.turns ?? [])[state.turn] ?? [{ text: "ok" }];
  state.turn++;
  state.turns.push({ prompt, sessionId, resumed: !!resume, ephemeral, system: value("--system-prompt"), model: value("--model") ?? null, jsonSchema: value("--json-schema") ? JSON.parse(value("--json-schema")) : null });
  save(state);

  // Lou's MCP server, reached over HTTP exactly like the real CLI would.
  let mcp;
  const configPath = value("--mcp-config");
  if (configPath) {
    const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.lou;
    let id = 0;
    const rpc = async (method, params, notification = false) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notification ? {} : { id: ++id }) }),
      });
      const s = load();
      s.mcpRequests.push({ method, status: res.status });
      save(s);
      return res.status === 202 ? null : res.json();
    };
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock-claude", version: "9.9.9" } });
    await rpc("notifications/initialized", {}, true);
    const list = await rpc("tools/list", {});
    mcp = { rpc, tools: list.result.tools, serverInfo: init.result.serverInfo };
    const s = load();
    s.toolNames = mcp.tools.map((t) => t.name);
    save(s);
  }

  const tools = [...(mcp?.tools ?? []).map((t) => `mcp__lou__${t.name}`), ...(value("--json-schema") ? ["StructuredOutput"] : []), ...(script.extraTools ?? [])];
  out({ type: "system", subtype: "init", session_id: sessionId, tools, mcp_servers: [...(mcp ? [{ name: "lou", status: "connected" }] : []), ...(script.extraMcpServers ?? [])], model: value("--model") ?? "mock-claude" });

  if (script.notLoggedIn) {
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sessionId });
    process.exit(1);
  }

  const partial = argv.includes("--include-partial-messages");
  let text = "";
  let structured;
  let error;
  for (const step of steps) {
    if (step.text !== undefined) {
      if (partial) for (const word of step.text.split(/(?<= )/)) out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } } });
      out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: step.text }] } });
      text = step.text;
    } else if (step.tool) {
      const toolUseId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
      out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: `mcp__lou__${step.tool}`, input: step.args ?? {} }] } });
      const res = await mcp.rpc("tools/call", { name: step.tool, arguments: step.args ?? {} });
      const s = load();
      s.toolResults.push({ tool: step.tool, isError: res.result?.isError ?? null, text: res.result?.content?.[0]?.text ?? null, error: res.error ?? null });
      save(s);
      out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: res.result?.content ?? [] }] } });
    } else if (step.parallel) {
      // Several tool uses in one assistant message, called concurrently like the real CLI.
      const uses = step.parallel.map((p) => ({ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2, 10)}`, name: `mcp__lou__${p.tool}`, input: p.args ?? {} }));
      out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: uses } });
      const results = await Promise.all(step.parallel.map((p) => mcp.rpc("tools/call", { name: p.tool, arguments: p.args ?? {} })));
      const s = load();
      results.forEach((res, i) => s.toolResults.push({ tool: step.parallel[i].tool, isError: res.result?.isError ?? null, text: res.result?.content?.[0]?.text ?? null, error: res.error ?? null }));
      save(s);
    } else if (step.nativeTool) {
      out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_native", name: step.nativeTool, input: { command: "rm -rf /" } }] } });
      await sleep(5000);
    } else if (step.structured) {
      out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_so", name: "StructuredOutput", input: step.structured }] } });
      structured = step.structured;
      text = JSON.stringify(step.structured);
    } else if (step.error) {
      error = step.error;
    } else if (step.hang) {
      await sleep(60_000);
    } else if (step.crash) {
      process.exit(3);
    }
  }

  out({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: !!error, result: error ?? text, session_id: sessionId, ...(structured ? { structured_output: structured } : {}) });
  process.exit(0);
}
