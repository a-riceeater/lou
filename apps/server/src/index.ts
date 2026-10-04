import { loadConfig } from "./config";
import { createServices } from "./container";
import { buildApp } from "./http/app";
import { createLogger } from "./logger";

/** Server entry point: config → services → HTTP/WS → graceful shutdown. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.env === "development" && process.stdout.isTTY);
  const services = createServices(config, logger);
  await services.start();
  const app = await buildApp(services);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("forced exit after shutdown timeout");
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await app.close();
      await services.stop();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

  await app.listen({ host: config.host, port: config.port });
  logger.info({ url: config.publicUrl, model: services.model ? config.openai.model : null, db: config.dbPath }, "lou server ready");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
