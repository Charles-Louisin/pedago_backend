import os from "node:os";
import { env } from "../config/env.js";
import { AiJob } from "../models/index.js";
import { logger } from "../utils/logger.js";
import { AiNotConfiguredError, BudgetExceededError } from "./openrouter.js";
import { runJob } from "./pipeline.js";
import { programImportSettled } from "../services/program-import.js";

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LOCK_MS = 10 * 60 * 1000;

/**
 * Réserve atomiquement une tâche prête (ou une tâche précise) : plusieurs workers et l'API
 * peuvent tourner sans double traitement.
 */
async function claim(jobId?: string) {
  const now = new Date();
  return AiJob.findOneAndUpdate(
    {
      ...(jobId ? { _id: jobId } : {}),
      status: { $in: ["queued", "running"] },
      nextRunAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    { status: "running", lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + LOCK_MS) },
    { sort: { nextRunAt: 1, createdAt: 1 }, new: true }
  );
}

/** Exécute une tâche réservée ; en cas d'échec : nouvelle tentative temporisée, ou échec définitif. */
async function execute(job: InstanceType<typeof AiJob>) {
  let failure: unknown = null;
  try {
    await runJob(job);
  } catch (err) {
    failure = err;
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
    } else if ((step?.attempts ?? 0) >= job.maxAttempts || (err as { statusCode?: number }).statusCode === 422 || (err as { statusCode?: number }).statusCode === 415) {
      // Document illisible : réessayer ne changerait rien.
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
  if (failure) await programImportSettled(job, failure).catch((err) => logger.error({ err }, "Import : mise à jour après échec"));
}

async function processOne() {
  const job = await claim();
  if (!job) return false;
  await execute(job);
  return true;
}

/**
 * Lance tout de suite une tâche précise dans ce processus (import de l'enseignant : pas d'attente du prochain tour).
 * Si le processus s'arrête en route, le verrou expire et un worker reprend la tâche à l'étape en cours.
 */
export function runJobNow(jobId: string) {
  void claim(jobId)
    .then((job) => (job ? execute(job) : undefined))
    .catch((err) => logger.error({ err, jobId }, "Tâche IA lancée immédiatement"));
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
