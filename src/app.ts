import "./utils/zod-fr.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import { pinoHttp } from "pino-http";
import { createRouteHandler } from "uploadthing/express";
import { env, isProduction } from "./config/env.js";
import { errorHandler } from "./middleware/errors.js";
import { logger } from "./utils/logger.js";
import { authRouter } from "./modules/auth.js";
import { teacherRouter } from "./modules/teacher.js";
import { libraryRouter } from "./modules/library.js";
import { publicRouter } from "./modules/public.js";
import { adminRouter } from "./modules/admin.js";
import { uploadRouter } from "./uploadthing/router.js";
import { localExportsDir } from "./services/storage.js";
import { verifyAccessToken } from "./utils/jwt.js";

function isAllowedOrigin(origin: string) {
  const allowed = env.corsOrigin.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  if (isProduction) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || /^(192\.168|10)\./.test(host) || /\.(exp\.direct|expo\.dev)$/.test(host);
  } catch {
    return false;
  }
}

/** Clé de limitation par compte (jeton vérifié), sinon par adresse IP. */
function accountKey(req: express.Request) {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    try {
      return `u:${verifyAccessToken(header.slice(7)).sub}`;
    } catch {
      // jeton invalide : refusé plus loin par requireAuth
    }
  }
  return `ip:${req.ip}`;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  // L'app mobile n'envoie pas d'en-tête Origin : seules les origines web sont filtrées.
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)), credentials: false }));
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  // Journaux compacts : méthode, route, statut, durée (pas d'en-têtes complets : plus léger et sans données sensibles).
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req: { url?: string }) => req.url?.startsWith("/api/v1/health") ?? false },
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url?.split("?")[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    })
  );

  const limiter = (windowMs: number, max: number, keyGenerator?: (req: express.Request) => string) =>
    rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, ...(keyGenerator ? { keyGenerator } : {}) });

  if (env.rateLimitMax > 0) app.use("/api/v1", limiter(env.rateLimitWindowMs, env.rateLimitMax));
  // Beaucoup d'enseignants partagent la même IP (réseau mobile, école) : limites par IP larges,
  // et limite stricte par identifiant pour bloquer le bourrage d'identifiants sur un compte.
  app.use(["/api/v1/auth/login", "/api/v1/auth/register"], limiter(15 * 60_000, 200));
  app.use(
    "/api/v1/auth/login",
    limiter(15 * 60_000, 10, (req) => `id:${String(req.body?.identifier ?? "").toLowerCase().slice(0, 160)}`)
  );
  app.use("/api/v1/auth/refresh", limiter(15 * 60_000, 600));
  // Codes de double authentification : peu d'essais par IP (le compte se bloque aussi après 5 échecs).
  app.use("/api/v1/auth/mfa/verify", limiter(15 * 60_000, 30));
  // Imports de fiches et de progressions (lecture par IA) : 30 par jour et par compte.
  app.use("/api/v1/teacher/imports", limiter(24 * 3_600_000, 30, (req) => `imp:${req.header("authorization")?.slice(-24) ?? req.ip}`));
  // Import « Mon programme » (plusieurs documents lus par IA) : 15 envois ou nouveaux essais par jour et par compte.
  // Le suivi de l'avancement (GET) et les corrections (PATCH) ne sont pas comptés.
  app.use(
    "/api/v1/teacher/program-imports",
    rateLimit({
      windowMs: 24 * 3_600_000,
      max: 15,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.method !== "POST" || /\/validate$/.test(req.path),
      keyGenerator: (req) => `prog:${accountKey(req)}`,
      message: { statusCode: 429, code: "TOO_MANY_IMPORTS", message: "Trop d'imports aujourd'hui : réessaie demain, ou corrige l'import en cours." },
    })
  );
  // Modification d'une fiche avec l'IA (recomposition immédiate) : 40 par jour et par compte ; fiches et reports : 300.
  app.use(/^\/api\/v1\/teacher\/lessons\/[^/]+\/file\/options$/, limiter(24 * 3_600_000, 40, (req) => `fopt:${accountKey(req)}`));
  // Illustrations générées (image IA, plus coûteuses) : 15 par jour et par compte.
  app.use(
    /^\/api\/v1\/teacher\/lessons\/[^/]+\/illustration$/,
    rateLimit({ windowMs: 24 * 3_600_000, max: 15, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method !== "POST", keyGenerator: (req) => `illus:${accountKey(req)}` })
  );
  app.use(/^\/api\/v1\/teacher\/lessons\/[^/]+\/(file|postpone)$/, limiter(24 * 3_600_000, 300, (req) => `file:${accountKey(req)}`));
  // Aperçus de fiche (niveau adapté par IA si besoin, mis en cache) : 200 par jour et par compte.
  app.use(/^\/api\/v1\/teacher\/lessons\/[^/]+\/preview$/, limiter(24 * 3_600_000, 200, (req) => `prev:${req.header("authorization")?.slice(-24) ?? req.ip}`));
  // Génération de PDF/Word : opération coûteuse, limitée par utilisateur authentifié.
  app.use(/^\/api\/v1\/library\/resources\/[^/]+\/export\//, limiter(10 * 60_000, 60, (req) => `exp:${req.header("authorization")?.slice(-24) ?? req.ip}`));

  app.get("/api/v1/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
  app.get("/api/v1/health/ready", (_req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ ready });
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/teacher", teacherRouter);
  app.use("/api/v1/library", libraryRouter);
  app.use("/api/v1/public", publicRouter);
  app.use("/api/v1/admin", adminRouter);
  app.use("/exports", express.static(localExportsDir, { maxAge: "30d", immutable: true }));

  if (env.uploadthingToken) {
    app.use("/api/uploadthing", createRouteHandler({ router: uploadRouter, config: { token: env.uploadthingToken } }));
  }

  app.use((_req, res) => res.status(404).json({ statusCode: 404, code: "NOT_FOUND", message: "Route introuvable" }));
  app.use(errorHandler);
  return app;
}
