import type { NextFunction, Request, Response } from "express";
import { Session } from "../models/user.js";
import { verifyAccessToken, type Role } from "../utils/jwt.js";
import { forbidden, unauthorized } from "../utils/http-error.js";

export type AuthedRequest = Request & { userId: string; role: Role; sessionId: string };

/**
 * Vérifie le jeton d'accès (courte durée) et que sa session n'a pas été révoquée.
 * Les autorisations par objet sont vérifiées dans chaque module (filtre teacherId systématique).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw unauthorized();
    const payload = verifyAccessToken(token);
    const session = await Session.findOne({ _id: payload.sid, userId: payload.sub, revokedAt: null })
      .select("_id")
      .lean();
    if (!session) throw unauthorized("Session expirée");
    const r = req as AuthedRequest;
    r.userId = payload.sub;
    r.role = payload.role;
    r.sessionId = payload.sid;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = (req as AuthedRequest).role;
    if (!role || !roles.includes(role)) return next(forbidden("FORBIDDEN_ROLE", "Rôle insuffisant"));
    next();
  };
}
