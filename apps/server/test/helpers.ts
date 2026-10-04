import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelProvider, type ScriptStep } from "@lou/agent";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config";
import { createServices, type Services } from "../src/container";
import { buildApp } from "../src/http/app";
import { createLogger } from "../src/logger";
import { generateMasterKey } from "../src/security/crypto";

export const MOCK_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "agent", "test", "fixtures", "mock-codex-app-server.mjs");

/** Reads the mock Codex App Server's request log for a test server. */
export function codexLog(server: TestServer): { launches: string[][]; requests: Array<{ method: string; params?: any }>; toolResults: any[] } {
  return JSON.parse(readFileSync(join(server.dataDir, "codex-state.json"), "utf8"));
}

export interface FakeMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  messageId: string;
  labelIds?: string[];
}

/**
 * In-memory Gmail + Google OAuth API used through the injected `fetch`. Records
 * every sent raw message so tests can assert on exactly what left the server.
 */
export class FakeGoogle {
  messages: FakeMessage[] = [];
  sent: Array<{ raw: string; threadId?: string; decoded: string; authorization: string }> = [];
  tokenRequests: URLSearchParams[] = [];
  historyId = "1000";
  failNextWith401 = false;

  constructor(readonly email = "me@example.com") {}

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (url.host === "oauth2.googleapis.com") {
      const body = new URLSearchParams(String(init?.body));
      this.tokenRequests.push(body);
      if (body.get("grant_type") === "authorization_code") {
        return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose" });
      }
      return json({ access_token: `access-${this.tokenRequests.length}`, expires_in: 3600 });
    }
    if (url.host === "openidconnect.googleapis.com") return json({ email: this.email, name: "Test User", sub: "1" });
    if (url.host !== "gmail.googleapis.com") return json({ error: "unexpected host" }, 500);

    if (this.failNextWith401) {
      this.failNextWith401 = false;
      return json({ error: { message: "invalid credentials" } }, 401);
    }
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: this.email, historyId: this.historyId });
    if (path === "/messages" && (init?.method ?? "GET") === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const from = /from:(\S+)/.exec(q)?.[1];
      const hits = this.messages.filter((m) => !from || m.from.toLowerCase().includes(from)).sort((a, b) => b.date.localeCompare(a.date));
      return json({ messages: hits.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const msgMatch = path === "/messages/send" ? null : /^\/messages\/([^/]+)$/.exec(path);
    if (msgMatch) {
      const m = this.messages.find((x) => x.id === decodeURIComponent(msgMatch[1]!));
      return m ? json(this.resource(m)) : json({ error: { message: "not found" } }, 404);
    }
    const threadMatch = /^\/threads\/([^/]+)$/.exec(path);
    if (threadMatch) {
      const msgs = this.messages.filter((x) => x.threadId === decodeURIComponent(threadMatch[1]!));
      return json({ id: threadMatch[1], messages: msgs.map((m) => this.resource(m, true)) });
    }
    if (path === "/messages/send") {
      const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
      this.sent.push({ ...body, decoded: Buffer.from(body.raw, "base64url").toString("utf8"), authorization: auth });
      return json({ id: `sent_${this.sent.length}`, threadId: body.threadId ?? "new" });
    }
    if (path === "/history") return json({ history: [], historyId: this.historyId });
    return json({ error: { message: `unhandled ${path}` } }, 404);
  };

  private resource(m: FakeMessage, full = false) {
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds ?? ["INBOX", "UNREAD"],
      snippet: m.body.slice(0, 80),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: m.to },
          { name: "Subject", value: m.subject },
          { name: "Date", value: m.date },
          { name: "Message-ID", value: m.messageId },
        ],
        body: full ? { data: Buffer.from(m.body).toString("base64url") } : {},
      },
    };
  }
}

/** Decodes the base64 text/plain body of a raw MIME message produced by the server. */
export function mimeBody(decoded: string): string {
  const [, body = ""] = decoded.split("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

export function mimeHeader(decoded: string, name: string): string | undefined {
  const head = decoded.split("\r\n\r\n")[0] ?? "";
  return head.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
}

export interface TestServer {
  services: Services;
  app: FastifyInstance;
  google: FakeGoogle;
  model: ScriptedModelProvider;
  dataDir: string;
  close(): Promise<void>;
}

export async function startTestServer(
  options: {
    steps?: ScriptStep[];
    dataDir?: string;
    masterKey?: string;
    google?: FakeGoogle;
    keepData?: boolean;
    env?: Record<string, string>;
    /** Script for the mock Codex App Server (enables the codex_cli provider backend). */
    codexScript?: Record<string, unknown>;
    /** Pass null to leave the OpenAI API provider unconfigured. */
    apiModel?: null;
  } = {},
): Promise<TestServer> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "lou-test-"));
  const config = loadConfig({
    LOU_ENV: "test",
    LOU_DATA_DIR: dataDir,
    LOU_MASTER_KEY: options.masterKey ?? generateMasterKey(),
    LOU_PUBLIC_URL: "http://localhost:8787",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    LOU_USER_NAME: "Alex",
    LOU_TIMEZONE: "UTC",
    LOU_IMPROVEMENT_ENABLED: "false",
    ...options.env,
  });
  const google = options.google ?? new FakeGoogle();
  const model = new ScriptedModelProvider(options.steps ?? []);
  let codex: { explicitPath: string; env: NodeJS.ProcessEnv } | undefined;
  if (options.codexScript) {
    const scriptPath = join(dataDir, "codex-script.json");
    writeFileSync(scriptPath, JSON.stringify(options.codexScript));
    codex = { explicitPath: MOCK_CODEX, env: { ...process.env, MOCK_CODEX_SCRIPT: scriptPath, MOCK_CODEX_STATE: join(dataDir, "codex-state.json") } };
  }
  const services = createServices(config, createLogger("silent" as "fatal", false), {
    fetch: google.fetch as typeof fetch,
    model: options.apiModel === null ? undefined : model,
    embeddings: null,
    transcriber: null,
    codex: codex ?? { explicitPath: join(dataDir, "no-codex", "codex.exe") },
  });
  await services.start();
  const app = await buildApp(services);
  await app.ready();
  return {
    services,
    app,
    google,
    model,
    dataDir,
    async close() {
      await app.close();
      await services.stop();
      if (!options.keepData && !options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Pairs a device over HTTP and returns its credentials. */
export async function pairDevice(server: TestServer, name = "Windows PC") {
  const { code } = server.services.devices.createPairingCode(server.services.owner.id, { type: "system" });
  const res = await server.app.inject({ method: "POST", url: "/api/devices/register", payload: { pairingCode: code, name, platform: "windows", capabilities: ["clipboard_read", "notifications"] } });
  if (res.statusCode !== 201) throw new Error(`pairing failed: ${res.body}`);
  return res.json() as { deviceId: string; deviceToken: string; commandKey: string; userId: string };
}

/** Connects a Gmail account through the real OAuth callback route (with the fake token endpoint). */
export async function connectGmail(server: TestServer, token: string): Promise<string> {
  const start = await server.app.inject({ method: "POST", url: "/api/accounts/google/connect", headers: { authorization: `Bearer ${token}` } });
  const authUrl = new URL(start.json().authUrl);
  const state = authUrl.searchParams.get("state")!;
  const cb = await server.app.inject({ method: "GET", url: `/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}` });
  if (cb.statusCode !== 200) throw new Error(`oauth callback failed: ${cb.body}`);
  return server.services.integrations.list(server.services.owner.id).find((a) => a.provider === "google")!.id;
}

export function waitForBus<K extends "run.completed" | "approval.requested" | "approval.resolved">(
  services: Services,
  event: K,
  predicate: (payload: any) => boolean = () => true,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const off = services.bus.on(event, (payload: any) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}
