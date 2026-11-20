/** Processus worker dédié (production) : `npm run start:worker`, avec AI_WORKER_IN_PROCESS=false côté API. */
import { assertSecureEnv } from "./config/env.js";
import { connectDb, disconnectDb } from "./db/connect.js";
import { startAiWorker } from "./ai/worker.js";
import { logger } from "./utils/logger.js";

async function main() {
  assertSecureEnv();
  await connectDb();
  const worker = startAiWorker();
  const stop = async () => {
    await worker.stop();
    await disconnectDb();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((err) => {
  logger.error({ err }, "Worker IA : démarrage impossible");
  process.exit(1);
});
