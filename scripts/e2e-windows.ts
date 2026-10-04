/**
 * Live end-to-end check of the Windows device agent against a real server:
 * pairs Lou.exe headlessly, launches it, waits for its WebSocket session, then
 * executes signed device commands through the server's ToolExecutor.
 *
 *   npx tsx scripts/e2e-windows.ts [path-to-Lou.exe]
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../apps/server/src/config";
import { createServices } from "../apps/server/src/container";
import { buildApp } from "../apps/server/src/http/app";
import { createLogger } from "../apps/server/src/logger";
import { generateMasterKey } from "../apps/server/src/security/crypto";

// Async on purpose: a sync child process would block this in-process server.
const run = promisify(execFile);
const exe = process.argv[2] ?? join(process.cwd(), "apps/windows/src/Lou.App/bin/x64/Debug/net10.0-windows10.0.19041.0/win-x64/Lou.exe");
const dataDir = mkdtempSync(join(tmpdir(), "lou-e2e-"));
const port = 8797;

const config = loadConfig({ LOU_ENV: "test", LOU_DATA_DIR: dataDir, LOU_MASTER_KEY: generateMasterKey(), LOU_PORT: String(port), LOU_IMPROVEMENT_ENABLED: "false" });
const services = createServices(config, createLogger("warn", false), { embeddings: null, transcriber: null });
await services.start();
const app = await buildApp(services);
await app.listen({ host: "127.0.0.1", port });

const { code } = services.devices.createPairingCode(services.owner.id, { type: "system" });
console.log((await run(exe, ["--pair", `http://127.0.0.1:${port}`, code, "E2E PC"])).stdout.trim());
const device = services.devices.list(services.owner.id, () => false)[0]!;

const child = spawn(exe, [], { detached: false, stdio: "ignore" });
let ok = false;
try {
  const deadline = Date.now() + 30_000;
  while (!services.gateway.isOnline(device.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (!services.gateway.isOnline(device.id)) throw new Error("device never connected");
  console.log("device online:", device.id, "capabilities:", services.devices.get(device.id)?.capabilities.join(", "));

  const invoke = (toolId: string, rawInput: Record<string, unknown>) =>
    services.executor.invoke({ toolId, rawInput, caller: "system", userId: services.owner.id, originDeviceId: device.id, tainted: false, signal: new AbortController().signal });

  const active = await invoke("device.get_active_window", {});
  console.log("get_active_window →", JSON.stringify(active.kind === "result" ? active.result : active));
  const files = await invoke("device.search_files", { query: "e2e-nonexistent-file-xyz", limit: 3 });
  console.log("search_files →", JSON.stringify(files.kind === "result" ? files.result : files));
  const blocked = await invoke("device.open_file", { path: "C:\\Windows\\System32\\cmd.exe" });
  console.log("open_file(cmd.exe) →", JSON.stringify(blocked.kind === "result" ? blocked.result : blocked));
  ok = active.kind === "result" && files.kind === "result" && files.result.success && blocked.kind === "result" && !blocked.result.success;
} finally {
  child.kill();
  await run(exe, ["--unpair"]);
  await app.close();
  await services.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(ok ? "E2E OK" : "E2E FAILED");
process.exit(ok ? 0 : 1);
