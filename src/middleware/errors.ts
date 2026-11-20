import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../utils/http-error.js";
import { logger } from "../utils/logger.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: err.issues[0]?.message || "Données invalides",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    if (err.statusCode >= 500) logger.error({ err }, "HttpError");
    return res.status(err.statusCode).json({ statusCode: err.statusCode, code: err.code, message: err.message });
  }
  const name = err?.name as string | undefined;
  if (name === "JsonWebTokenError" || name === "TokenExpiredError" || name === "NotBeforeError") {
    return res.status(401).json({ statusCode: 401, code: "UNAUTHORIZED", message: "Session expirée" });
  }
  if (name === "CastError" || name === "BSONError") {
    return res.status(400).json({ statusCode: 400, code: "BAD_ID", message: "Identifiant invalide" });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ statusCode: 409, code: "DUPLICATE", message: "Cet élément existe déjà" });
  }
  const status = Number(err?.status || err?.statusCode);
  if (err?.expose && status >= 400 && status < 500) {
    return res.status(status).json({ statusCode: status, code: status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", message: "Requête invalide" });
  }
  logger.error({ err, path: req.originalUrl, method: req.method }, "Erreur non gérée");
  return res.status(500).json({ statusCode: 500, code: "INTERNAL", message: "Erreur serveur" });
};
