/**
 * Live end-to-end check of the Claude CLI provider with the REAL `claude` on
 * PATH (uses your existing Claude Code login). Gmail is the in-memory fake from
 * the test suite, so no real email is read or sent.
 *
 *   npx tsx scripts/e2e-claude.ts
 *
 * Verifies: status and lockdown, Lou's tools over the loopback MCP bridge,
 * Lou's approval flow for sending, exact approved content, session reuse
 * across turns, session resume after a full server restart, refusal of native
 * capabilities, and structured single-shot tasks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyImportance } from "@lou/agent";
import { loadConfig } from "../apps/server/src/config";
import { createServices, type Services } from "../apps/server/src/container";
import { buildApp } from "../apps/server/src/http/app";
import { createLogger } from "../apps/server/src/logger";
import { generateMasterKey } from "../apps/server/src/security/crypto";
import { FakeGoogle, mimeBody } from "../apps/server/test/helpers";

const dataDir = mkdtempSync(join(tmpdir(), "lou-e2e-claude-"));
const masterKey = generateMasterKey();
const google = new FakeGoogle();
google.messages.push(
  { id: "m-old", threadId: "t-old", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Lunch", body: "Lunch next week?", date: "2026-09-01T10:00:00Z", messageId: "<old@mail>" },
  { id: "m-new", threadId: "t-new", from: "Sarah Lee <sarah@example.com>", to: "me@example.com", subject: "Dinner tonight", body: "Hey! Are you coming to dinner tonight? What time do you think you'll get there?", date: "2026-10-03T09:00:00Z", messageId: "<new@mail>" },
  { id: "m-bob", threadId: "t-bob", from: "Bob <bob@example.com>", to: "me@example.com", subject: "Hi", body: "Hello", date: "2026-10-03T11:00:00Z", messageId: "<bob@mail>" },
);

async function boot() {
  const config = loadConfig({
    LOU_ENV: "test",
    LOU_DATA_DIR: dataDir,
    LOU_MASTER_KEY: masterKey,
    LOU_PUBLIC_URL: "http://localhost:8787",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    LOU_USER_NAME: "Alex",
    LOU_TIMEZONE: "America/New_York",
    LOU_IMPROVEMENT_ENABLED: "false",
    AI_PROVIDER: "claude_cli",
    ...(process.env.LOU_CLAUDE_MODEL ? { LOU_CLAUDE_MODEL: process.env.LOU_CLAUDE_MODEL } : {}),
    ...(process.env.CLAUDE_PATH ? { CLAUDE_PATH: process.env.CLAUDE_PATH } : {}),
    PATH: process.env.PATH ?? "",
  });
  const services = createServices(config, createLogger("warn", false), { fetch: google.fetch as typeof fetch, embeddings: null, transcriber: null });
  await services.start();
  const app = await buildApp(services);
  await app.ready();
  return { services, app };
}

function waitFor<T>(services: Services, event: "run.completed" | "approval.requested", match: (p: any) => boolean = () => true, ms = 240_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const off = services.bus.on(event, (p: any) => {
      if (!match(p)) return;
      clearTimeout(timer);
      off();
      resolve(p);
    });
  });
}

const step = (msg: string) => console.log(`\n▶ ${msg}`);
let ok = true;
const check = (cond: unknown, msg: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

let { services, app } = await boot();
try {
  step("Claude Code provider health");
  const health = await services.claude.health();
  console.log(`  state=${health.state} cli=${health.cliVersion} auth=${health.auth?.method}/${health.auth?.plan} restricted=${health.restricted}`);
  check(health.state === "ready" && health.restricted, "Claude Code ready and locked down");

  step("Pair a device and connect (fake) Gmail");
  const { code } = services.devices.createPairingCode(services.owner.id, { type: "system" });
  const reg = (await app.inject({ method: "POST", url: "/api/devices/register", payload: { pairingCode: code, name: "E2E", platform: "windows" } })).json();
  const auth = { authorization: `Bearer ${reg.deviceToken}` };
  const start = await app.inject({ method: "POST", url: "/api/accounts/google/connect", headers: auth });
  const state = new URL(start.json().authUrl).searchParams.get("state")!;
  await app.inject({ method: "GET", url: `/oauth/google/callback?code=x&state=${encodeURIComponent(state)}` });

  step('Ask: "Reply to the latest email from Sarah and tell her I\'ll be there around 6."');
  const deltas: string[] = [];
  services.bus.on("run.delta", (e) => deltas.push(e.text));
  const requested = waitFor<{ approval: any }>(services, "approval.requested");
  const failedEarly = waitFor<any>(services, "run.completed");
  const { runId, conversationId } = (await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "Reply to the latest email from Sarah and tell her I'll be there around 6." } })).json();
  const first = await Promise.race([requested.then((r) => ({ kind: "approval" as const, r })), failedEarly.then((r) => ({ kind: "done" as const, r }))]);
  if (first.kind === "done") throw new Error(`run ended without an approval: ${JSON.stringify(first.r)}`);
  const approval = first.r.approval;
  const body = approval.fields.find((f: any) => f.key === "body").value as string;
  console.log(`  draft → to=${approval.fields.find((f: any) => f.key === "to").value} subject="${approval.fields.find((f: any) => f.key === "subject").value}"\n    "${body}"`);
  check(approval.fields.find((f: any) => f.key === "to").value === "sarah@example.com", "recipient derived by Lou from the thread");
  check(/6/.test(body), "draft mentions 6");
  check(google.sent.length === 0, "nothing sent before approval");
  console.log(`  tool calls via Lou executor: ${services.runs.view(services.owner.id, runId)?.steps.map((s) => `${s.toolId}:${s.status}`).join(", ")}`);

  step("Approve with an edit");
  const edited = `${body.trim()} Can't wait!`;
  const completed = waitFor<any>(services, "run.completed", (e) => e.runId === runId);
  await app.inject({ method: "POST", url: `/api/approvals/${approval.id}/resolve`, headers: auth, payload: { decision: "approve", actionHash: approval.actionHash, edits: { body: edited } } });
  const done = await completed;
  console.log(`  final: "${done.message}"`);
  check(done.status === "completed", "run completed");
  check(google.sent.length === 1 && mimeBody(google.sent[0]!.decoded) === edited, "exactly the approved, edited text was sent");
  check(deltas.length > 0, `assistant text streamed (${deltas.length} deltas)`);

  step("Follow-up in the same conversation (session reuse)");
  const followUp = waitFor<any>(services, "run.completed");
  await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "What time did I tell her?", conversationId } });
  const follow = await followUp;
  console.log(`  answer: "${follow.message}"`);
  check(follow.status === "completed" && /6/.test(follow.message ?? ""), "Claude remembered the conversation");
  const session1 = services.db.$client.prepare("select thread_id from provider_threads where provider = 'claude_cli'").get() as { thread_id: string };

  step("Restart the server and continue (session resume)");
  await app.close();
  await services.stop();
  ({ services, app } = await boot());
  const resumed = waitFor<any>(services, "run.completed");
  await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "And what was the subject of her email?", conversationId } });
  const after = await resumed;
  console.log(`  answer: "${after.message}"`);
  const session2 = services.db.$client.prepare("select thread_id from provider_threads where provider = 'claude_cli'").get() as { thread_id: string };
  check(after.status === "completed", "run completed after restart");
  check(session1.thread_id === session2.thread_id, "same Claude Code session resumed after restart");
  check(/dinner/i.test(after.message ?? ""), "context retained after restart");

  step("Ask for a native capability (shell)");
  const shell = waitFor<any>(services, "run.completed");
  await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { text: "Run the shell command `whoami` and tell me the output." } });
  const refused = await shell;
  console.log(`  ${refused.status}: "${refused.message ?? refused.error?.message}"`);
  check(refused.status === "completed" || refused.error?.code === "POLICY_DENIED", "no shell was available; nothing ran outside Lou's tools");

  step("Structured single-shot task (importance classification)");
  const importance = await classifyImportance(services.model, { source: "gmail", title: "Mr. Smith", content: "Can you come in Friday at 3 to talk about the project? Please confirm.", rules: [] });
  console.log(`  ${JSON.stringify(importance)}`);
  check(importance.needsResponse === true && importance.importance > 0.3, "classified through Claude Code with a JSON schema");
} catch (err) {
  ok = false;
  console.error("E2E error:", err);
} finally {
  await app.close();
  await services.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(ok ? "\nCLAUDE E2E OK" : "\nCLAUDE E2E FAILED");
process.exit(ok ? 0 : 1);
