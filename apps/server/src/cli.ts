import { loadConfig } from "./config";
import { createServices } from "./container";
import { createLogger } from "./logger";
import { generateMasterKey } from "./security/crypto";

/**
 * Administrative CLI, run on the server host (direct database access):
 *   lou gen-key              print a new LOU_MASTER_KEY
 *   lou pair [--name X]      create a one-time device pairing code (10 min)
 *   lou devices              list devices
 *   lou revoke <deviceId>    revoke a device credential
 *   lou audit [n]            show recent audit entries
 *   lou controls [k=v ...]   show or set emergency controls (e.g. agentPaused=true)
 */
async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "gen-key") {
    console.log(generateMasterKey());
    return;
  }
  if (command === "help" || command === "--help") {
    console.log("Usage: lou <gen-key|pair|devices|revoke <id>|audit [n]|controls [key=value ...]>");
    return;
  }

  const config = loadConfig();
  const services = createServices(config, createLogger("warn", false));
  const owner = services.owner;
  try {
    switch (command) {
      case "pair": {
        const { code, expiresAt } = services.devices.createPairingCode(owner.id, { type: "system", id: "cli" });
        console.log(`\n  Pairing code:  ${code}\n  Server URL:    ${config.publicUrl}\n  Expires:       ${new Date(expiresAt).toLocaleTimeString()}\n`);
        console.log("  Enter these in the Lou app on the device you want to connect.\n");
        break;
      }
      case "devices": {
        for (const d of services.devices.list(owner.id, () => false)) {
          console.log(`${d.id}  ${d.status.padEnd(8)} ${d.platform.padEnd(8)} ${d.name}  last seen ${d.lastSeenAt ?? "never"}`);
        }
        break;
      }
      case "revoke": {
        const id = args[0];
        if (!id) throw new Error("Usage: lou revoke <deviceId>");
        services.devices.revoke(owner.id, id, { type: "system", id: "cli" });
        console.log(`Revoked ${id}.`);
        break;
      }
      case "audit": {
        const limit = Number(args[0] ?? 30);
        for (const e of services.audit.list({ limit }).reverse()) {
          console.log(`${e.createdAt}  ${e.actorType.padEnd(6)} ${e.action.padEnd(28)} ${e.targetType ?? ""} ${e.targetId ?? ""}`);
        }
        break;
      }
      case "controls": {
        if (args.length) {
          const patch: Record<string, boolean> = {};
          for (const arg of args) {
            const [k, v] = arg.split("=");
            if (!k || (v !== "true" && v !== "false")) throw new Error(`Invalid setting "${arg}" (use key=true|false)`);
            patch[k] = v === "true";
          }
          services.settings.update(patch, { userId: owner.id });
        }
        console.log(services.settings.get());
        break;
      }
      default:
        throw new Error(`Unknown command "${command}"`);
    }
  } finally {
    await services.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
