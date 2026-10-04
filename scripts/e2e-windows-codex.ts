/**
 * Live end-to-end check through the REAL Windows app with the REAL Codex CLI:
 * an in-process server (AI_PROVIDER=codex_cli, fake Gmail) + Lou.exe, whose
 * palette UI is driven through WebView2's DevTools protocol exactly as a user
 * would: type a request, watch the streamed answer, edit the draft, press Send.
 *
 *   npx tsx scripts/e2e-windows-codex.ts [path-to-Lou.exe]
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { loadConfig } from "../apps/server/src/config";
import { createServices } from "../apps/server/src/container";
import { buildApp } from "../apps/server/src/http/app";
import { createLogger } from "../apps/server/src/logger";
import { generateMasterKey } from "../apps/server/src/security/crypto";
import { FakeGoogle, mimeBody } from "../apps/server/test/helpers";

const run = promisify(execFile);
const exe = process.argv[2] ?? join(process.cwd(), "apps/windows/src/Lou.App/bin/x64/Debug/net10.0-windows10.0.19041.0/win-x64/Lou.exe");
const port = 8796;
const cdpPort = 9339;
const dataDir = mkdtempSync(join(tmpdir(), "lou-e2e-wc-"));
const google = new FakeGoogle();
google.messages.push({ id: "m-new", threadId: "t-new", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Dinner tonight", body: "Hey! Are you coming to dinner tonight? What time will you get there?", date: "2026-10-03T09:00:00Z", messageId: "<new@mail>" });

const config = loadConfig({
  LOU_ENV: "test",
  LOU_DATA_DIR: dataDir,
  LOU_MASTER_KEY: generateMasterKey(),
  LOU_PORT: String(port),
  LOU_PUBLIC_URL: `http://127.0.0.1:${port}`,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  LOU_USER_NAME: "Alex",
  LOU_IMPROVEMENT_ENABLED: "false",
  AI_PROVIDER: "codex_cli",
  PATH: process.env.PATH ?? "",
});
const services = createServices(config, createLogger("warn", false), { fetch: google.fetch as typeof fetch, embeddings: null, transcriber: null });
await services.start();
const app = await buildApp(services);
await app.listen({ host: "127.0.0.1", port });

let ok = true;
const check = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Connect the fake Gmail account through the real OAuth callback path.
const { authUrl } = services.google.startConnect(services.owner.id);
await services.google.handleCallback({ code: "x", state: new URL(authUrl).searchParams.get("state")! });

const { code } = services.devices.createPairingCode(services.owner.id, { type: "system" });
console.log((await run(exe, ["--pair", `http://127.0.0.1:${port}`, code, "E2E Codex PC"])).stdout.trim());
const device = services.devices.list(services.owner.id, () => false)[0]!;
const child = spawn(exe, [], { stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` } });

try {
  for (let i = 0; i < 120 && !services.gateway.isOnline(device.id); i++) await sleep(250);
  check(services.gateway.isOnline(device.id), "Lou.exe connected over WebSocket");

  // Find the palette page in the app's WebView2 and attach.
  let target: { webSocketDebuggerUrl: string; url: string } | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      target = pages.find((p) => p.type === "page" && p.url.includes("#/palette"));
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error("palette WebView not found");
  console.log(`  attached to ${target.url}`);
  const cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => cdp.once("open", r));
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  cdp.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id) pending.get(m.id)?.(m.result);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      cdp.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

  // Type the request into the palette exactly like a user.
  await sleep(1000);
  await evaluate(`document.querySelector('input[aria-label="Ask Lou"]').focus()`);
  await send("Input.insertText", { text: "Reply to the latest email from Sarah and tell her I'll be there around 6." });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(800);
  // Hidden windows may not turn synthetic Enter into implicit submission; submit the form the same way Enter does.
  if (!services.runs.history(services.owner.id, {}).length) await evaluate("document.querySelector('form.prompt').requestSubmit()");
  await sleep(700);

  // Watch the UI: presence states, then the editable approval.
  const phases = new Set<string>();
  let approval = false;
  for (let i = 0; i < 360 && !approval; i++) {
    const s = await evaluate(`({ phase: document.querySelector('[data-testid="presence"]')?.dataset.phase, body: document.querySelector('textarea[aria-label="Message"]')?.value ?? null, err: document.querySelector('[role="alert"]')?.textContent ?? null })`);
    if (s?.phase) phases.add(s.phase);
    if (s?.err) throw new Error(`UI error: ${s.err}`);
    approval = s?.body != null;
    if (!approval) await sleep(500);
  }
  console.log(`  UI phases seen: ${[...phases].join(" → ")}`);
  check(approval, "editable approval card shown in the palette");
  const draft = await evaluate(`document.querySelector('textarea[aria-label="Message"]').value`);
  console.log(`  draft: "${draft}"`);
  check(google.sent.length === 0, "nothing sent before approval");

  // Edit the draft in place and press Send.
  await evaluate(`(() => { const t = document.querySelector('textarea[aria-label="Message"]'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
  await send("Input.insertText", { text: " See you soon!" });
  const edited = await evaluate(`document.querySelector('textarea[aria-label="Message"]').value`);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send').click()`);

  // Watch for streamed text and the final answer.
  const streamed: string[] = [];
  let answer: string | null = null;
  for (let i = 0; i < 360 && !answer; i++) {
    const s = await evaluate(`({ stream: document.querySelector('[data-testid="stream"]')?.textContent ?? null, answer: document.querySelector('[data-testid="answer"]')?.textContent ?? null })`);
    if (s?.stream && streamed.at(-1) !== s.stream) streamed.push(s.stream);
    answer = s?.answer ?? null;
    if (!answer) await sleep(150);
  }
  console.log(`  streamed snapshots: ${streamed.length}${streamed.length ? ` (first: "${streamed[0]}")` : ""}`);
  console.log(`  answer: "${answer}"`);
  check(!!answer, "final answer shown in the palette");
  check(google.sent.length === 1 && mimeBody(google.sent[0]!.decoded) === edited, "exactly the edited draft was sent");
  check(phases.has("thinking") || phases.has("tool"), "thinking/tool states shown while Codex worked");

  // A plain question: the answer streams into the palette as Codex writes it.
  await sleep(3000); // completed actions auto-dismiss the palette back to idle
  await evaluate(`document.querySelector('input[aria-label="Ask Lou"]').focus()`);
  await send("Input.insertText", { text: "In two or three sentences, what did Sarah ask me and what did I answer?" });
  await evaluate("document.querySelector('form.prompt').requestSubmit()");
  const snapshots: string[] = [];
  let reply: string | null = null;
  let started = false;
  for (let i = 0; i < 800 && !reply; i++) {
    const s = await evaluate(`({ phase: document.querySelector('[data-testid="presence"]')?.dataset.phase, stream: document.querySelector('[data-testid="stream"]')?.textContent ?? null, answer: document.querySelector('[data-testid="answer"]')?.textContent ?? null })`);
    if (s?.phase === "thinking" || s?.phase === "tool") started = true;
    if (s?.stream && snapshots.at(-1) !== s.stream) snapshots.push(s.stream);
    // Only accept the answer of *this* run (the previous one may still be animating out).
    reply = started && s?.phase === "success" ? (s?.answer ?? null) : null;
    if (!reply) await sleep(50);
  }
  console.log(`  streamed snapshots: ${snapshots.length} (e.g. "${snapshots[Math.floor(snapshots.length / 2)] ?? ""}")`);
  console.log(`  reply: "${reply}"`);
  check(snapshots.length >= 2, "answer streamed into the palette progressively");
  check(!!reply && /6/.test(reply), "conversation continuity in the same Codex thread");
  cdp.close();
} catch (err) {
  ok = false;
  console.error("E2E error:", err);
} finally {
  child.kill();
  await run(exe, ["--unpair"]).catch(() => undefined);
  await app.close();
  await services.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(ok ? "\nWINDOWS + CODEX E2E OK" : "\nWINDOWS + CODEX E2E FAILED");
process.exit(ok ? 0 : 1);
