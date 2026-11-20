import os from "node:os";
import { env } from "../config/env.js";
import { AiJob } from "../models/index.js";
import { logger } from "../utils/logger.js";
import { AiNotConfiguredError, BudgetExceededError } from "./openrouter.js";
import { runJob } from "./pipeline.js";

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LOCK_MS = 10 * 60 * 1000;

/** Réserve atomiquement une tâche prête : plusieurs workers peuvent tourner sans double traitement. */
async function claim() {
  const now = new Date();
  return AiJob.findOneAndUpdate(
    {
      status: { $in: ["queued", "running"] },
      nextRunAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    { status: "running", lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + LOCK_MS) },
    { sort: { nextRunAt: 1, createdAt: 1 }, new: true }
  );
}

async function processOne() {
  const job = await claim();
  if (!job) return false;
  try {
    await runJob(job);
  } catch (err) {
    const message = (err as Error).message?.slice(0, 1000) ?? "Erreur";
    const step = job.steps[job.currentStep];
    if (step) {
      step.status = "failed";
      step.error = message;
    }
    job.lastError = message;
    if (err instanceof BudgetExceededError) {
      job.status = "budget_exceeded";
    } else if (err instanceof AiNotConfiguredError) {
      job.status = "failed";
    } else if ((step?.attempts ?? 0) >= job.maxAttempts) {
      job.status = "failed";
    } else {
      // Nouvelle tentative avec temporisation exponentielle, à partir de l'étape échouée.
      if (step) step.status = "pending";
      job.status = "queued";
      job.nextRunAt = new Date(Date.now() + 30_000 * 2 ** (step?.attempts ?? 1));
    }
    logger.warn({ jobId: String(job._id), err: message, status: job.status }, "Tâche IA en échec");
  } finally {
    job.lockedBy = undefined;
    job.lockedUntil = undefined;
    await job.save();
  }
  return true;
}

export function startAiWorker() {
  let stopped = false;
  const lanes = Array.from({ length: Math.max(1, env.aiWorkerConcurrency) }, async () => {
    while (!stopped) {
      const worked = await processOne().catch((err) => {
        logger.error({ err }, "Worker IA");
        return false;
      });
      if (!worked) await new Promise((r) => setTimeout(r, env.aiWorkerPollMs));
    }
  });
  logger.info({ worker: WORKER_ID, concurrency: env.aiWorkerConcurrency }, "Worker IA démarré");
  return {
    async stop() {
      stopped = true;
      await Promise.race([Promise.all(lanes), new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}
