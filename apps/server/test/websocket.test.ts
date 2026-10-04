import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { pairDevice, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
afterEach(async () => server?.close());

function frame(type: string, payload: unknown) {
  return JSON.stringify({ v: 1, id: `c_${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(), type, payload });
}

class TestClient {
  readonly frames: any[] = [];
  private waiters: Array<{ match: (f: any) => boolean; resolve: (f: any) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString());
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.match(f) ? (w.resolve(f), false) : true));
    });
  }
  next(type: string, predicate: (f: any) => boolean = () => true, timeout = 3000): Promise<any> {
    const existing = this.frames.find((f) => f.type === type && predicate(f) && !f.__seen);
    if (existing) {
      existing.__seen = true;
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
      this.waiters.push({
        match: (f) => f.type === type && predicate(f),
        resolve: (f) => {
          clearTimeout(timer);
          f.__seen = true;
          resolve(f);
        },
      });
    });
  }
  send(type: string, payload: unknown) {
    this.ws.send(frame(type, payload));
  }
  close() {
    return new Promise<void>((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

async function connect(url: string, token: string, hello: Record<string, unknown> = {}): Promise<TestClient> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
  const client = new TestClient(ws);
  client.send("device.hello", { platform: "windows", clientVersion: "test", capabilities: ["clipboard_read", "notifications"], ...hello });
  return client;
}

async function listen(): Promise<string> {
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws`;
}

describe("device websocket", () => {
  it("rejects invalid credentials before upgrading", async () => {
    server = await startTestServer();
    const url = await listen();
    await expect(connect(url, "lou_dev_nope")).rejects.toThrow("HTTP 401");
  });

  it("delivers pushes and replays missed frames after reconnect", async () => {
    server = await startTestServer();
    const url = await listen();
    const device = await pairDevice(server);
    const userId = server.services.owner.id;
    const notify = (title: string) => server.services.notifications.create({ userId, source: "test", title, body: "b", importance: 0.9 });

    const c1 = await connect(url, device.deviceToken);
    const ready = await c1.next("session.ready");
    expect(ready.payload).toMatchObject({ deviceId: device.deviceId, resyncRequired: true });
    notify("first");
    const first = await c1.next("notification.created");
    expect(first.payload.notification.title).toBe("first");
    expect(server.services.gateway.isOnline(device.deviceId)).toBe(true);
    await c1.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.services.gateway.isOnline(device.deviceId)).toBe(false);

    notify("second");
    notify("third");
    const c2 = await connect(url, device.deviceToken, { lastSeq: first.seq });
    const ready2 = await c2.next("session.ready");
    expect(ready2.payload.resyncRequired).toBe(false);
    const replayed = [await c2.next("notification.created"), await c2.next("notification.created")].map((f) => f.payload.notification.title);
    expect(replayed).toEqual(["second", "third"]);
    await c2.close();
  });

  it("sends signed device commands and returns the device result", async () => {
    server = await startTestServer();
    const url = await listen();
    const device = await pairDevice(server);
    const client = await connect(url, device.deviceToken);
    await client.next("session.ready");

    const pending = server.services.executor.invoke({
      toolId: "device.get_clipboard",
      rawInput: {},
      caller: "system",
      userId: server.services.owner.id,
      originDeviceId: device.deviceId,
      tainted: false,
      signal: new AbortController().signal,
    });
    const cmd = await client.next("device.command");
    // The client verifies the HMAC over the exact body string with its command key.
    const expected = createHmac("sha256", Buffer.from(device.commandKey, "base64")).update(cmd.payload.body, "utf8").digest("base64");
    expect(cmd.payload.signature).toBe(expected);
    const body = JSON.parse(cmd.payload.body);
    expect(body).toMatchObject({ deviceId: device.deviceId, toolId: "device.get_clipboard", input: {} });
    client.send("device.command.result", { commandId: body.commandId, success: true, result: { text: "copied text" } });

    const outcome = await pending;
    expect(outcome.kind).toBe("result");
    expect(outcome.kind === "result" && outcome.result).toEqual({ success: true, data: { text: "copied text" } });
    await client.close();
  });

  it("fails device tools cleanly when the device is offline", async () => {
    server = await startTestServer();
    const device = await pairDevice(server);
    const outcome = await server.services.executor.invoke({
      toolId: "device.get_clipboard",
      rawInput: {},
      caller: "system",
      userId: server.services.owner.id,
      originDeviceId: device.deviceId,
      tainted: false,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ kind: "denied", error: { code: "DEVICE_OFFLINE" } });
  });

  it("disconnects a revoked device immediately", async () => {
    server = await startTestServer();
    const url = await listen();
    const device = await pairDevice(server);
    const client = await connect(url, device.deviceToken);
    await client.next("session.ready");
    const closed = new Promise<number>((r) => client.ws.once("close", (code) => r(code)));
    server.services.devices.revoke(server.services.owner.id, device.deviceId, { type: "system" });
    expect(await client.next("device.revoked")).toBeTruthy();
    expect(await closed).toBe(4001);
  });
});
