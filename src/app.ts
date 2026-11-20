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
import { adminRouter } from "./modules/admin.js";
import { uploadRouter } from "./uploadthing/router.js";
import { localExportsDir } from "./services/storage.js";

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
  app.use("/api/v1/admin", adminRouter);
  app.use("/exports", express.static(localExportsDir, { maxAge: "30d", immutable: true }));

  if (env.uploadthingToken) {
    app.use("/api/uploadthing", createRouteHandler({ router: uploadRouter, config: { token: env.uploadthingToken } }));
  }

  app.use((_req, res) => res.status(404).json({ statusCode: 404, code: "NOT_FOUND", message: "Route introuvable" }));
  app.use(errorHandler);
  return app;
}
