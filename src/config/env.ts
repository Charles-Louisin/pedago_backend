import "dotenv/config";

const nodeEnv = process.env.NODE_ENV || "development";
export const isProduction = nodeEnv === "production";

function str(name: string, fallback = "") {
  return (process.env[name] ?? fallback).trim();
}
function num(name: string, fallback: number) {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean) {
  const raw = str(name).toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export const env = {
  nodeEnv,
  port: num("PORT", 5100),
  mongoUri: str("MONGODB_URI", "mongodb://127.0.0.1:27017/pedago"),
  /** Démarre une base MongoDB en mémoire si aucune base n'est joignable (développement uniquement). */
  mongoMemoryFallback: !isProduction && bool("MONGO_MEMORY_FALLBACK", true),
  jwtSecret: str("JWT_SECRET", "change-me-pedago-jwt-secret"),
  accessTokenTtlSec: num("ACCESS_TOKEN_TTL_SEC", 15 * 60),
  refreshTokenTtlDays: num("REFRESH_TOKEN_TTL_DAYS", 30),
  corsOrigin: str("CORS_ORIGIN", "http://localhost:3100"),
  publicApiUrl: str("PUBLIC_API_URL").replace(/\/$/, ""),
  rateLimitMax: num("RATE_LIMIT_MAX", isProduction ? 400 : 3000),
  rateLimitWindowMs: num("RATE_LIMIT_WINDOW_MS", 60_000),

  uploadthingToken: str("UPLOADTHING_TOKEN"),

  /** Clé OpenRouter : utilisée uniquement côté serveur, jamais exposée à l'app mobile. */
  openrouterApiKey: str("OPENROUTER_API_KEY"),
  openrouterBaseUrl: str("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  /** Modèles par rôle du pipeline : à choisir après comparaison sur un jeu de tests réel. */
  aiModelClassify: str("AI_MODEL_CLASSIFY", "google/gemini-2.5-flash"),
  aiModelExtract: str("AI_MODEL_EXTRACT", "google/gemini-2.5-flash"),
  aiModelWrite: str("AI_MODEL_WRITE", "anthropic/claude-sonnet-4.5"),
  aiModelReview: str("AI_MODEL_REVIEW", "openai/gpt-5-mini"),
  aiJobDefaultBudgetUsd: num("AI_JOB_DEFAULT_BUDGET_USD", 2),
  /** Plafond global de dépense IA sur 24 h glissantes (toutes tâches confondues). */
  aiDailyBudgetUsd: num("AI_DAILY_BUDGET_USD", 20),
  /** Nombre maximal de générations créées par une production « bibliothèque ». */
  aiMaxJobsPerBuild: num("AI_MAX_JOBS_PER_BUILD", 300),
  aiRequestTimeoutMs: num("AI_REQUEST_TIMEOUT_MS", 180_000),
  aiWorkerConcurrency: num("AI_WORKER_CONCURRENCY", 2),
  aiWorkerPollMs: num("AI_WORKER_POLL_MS", 4_000),
  /** Lance le worker IA dans le processus API (désactiver si `npm run start:worker` tourne à part). */
  aiWorkerInProcess: bool("AI_WORKER_IN_PROCESS", !isProduction),
  /** Domaines autorisés pour la recherche documentaire (liste blanche, séparés par des virgules). */
  sourceDomainAllowlist: str(
    "SOURCE_DOMAIN_ALLOWLIST",
    "minedub.cm,www.minedub.cm,minesec.gov.cm,www.minesec.gov.cm,prc.cm,www.prc.cm,minac.gov.cm,www.minac.gov.cm,spm.gov.cm,www.spm.gov.cm"
  )
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
};

const WEAK_JWT = new Set(["", "change-me-pedago-jwt-secret", "secret"]);

export function assertSecureEnv() {
  if (!isProduction) return;
  if (WEAK_JWT.has(env.jwtSecret) || env.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET doit être une valeur forte (32 caractères minimum) en production.");
  }
  if (env.corsOrigin.includes("*")) {
    throw new Error("CORS_ORIGIN ne peut pas contenir * en production.");
  }
}
