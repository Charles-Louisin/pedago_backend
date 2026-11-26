import { createApp } from "./app.js";
import { assertSecureEnv, env } from "./config/env.js";
import { connectDb, disconnectDb } from "./db/connect.js";
import { logger } from "./utils/logger.js";
import { startAiWorker } from "./ai/worker.js";
import { startReminders } from "./services/notifications.js";

async function main() {
  assertSecureEnv();
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, "0.0.0.0", () => logger.info({ port: env.port }, "PEDAGO API démarrée"));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  const worker = env.aiWorkerInProcess ? startAiWorker() : null;
  // Rappels push (cours, bilan, fiches du lendemain) : une vérification par minute.
  const stopReminders = env.remindersInProcess ? startReminders() : null;
  const shutdown = async () => {
    logger.info("Arrêt en cours…");
    server.close();
    await worker?.stop();
    stopReminders?.();
    await disconnectDb();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Démarrage impossible");
  process.exit(1);
});
