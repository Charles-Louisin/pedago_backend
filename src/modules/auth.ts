import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Session, User, TeacherProfile, AuditLog } from "../models/index.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ah, badRequest, conflict, unauthorized, HttpError } from "../utils/http-error.js";
import { hashToken, newRefreshToken, signAccessToken, type Role } from "../utils/jwt.js";
import { env } from "../config/env.js";

export const authRouter = Router();

const password = z.string().min(8, "8 caractères minimum").max(128);
const identifier = z.string().trim().min(3).max(160);

const registerSchema = z
  .object({
    fullName: z.string().trim().min(2, "Nom trop court").max(120),
    email: z.string().trim().toLowerCase().email("E-mail invalide").optional(),
    phone: z.string().trim().regex(/^\+?\d{8,15}$/, "Téléphone invalide").optional(),
    password,
    device: z.string().max(120).optional(),
  })
  .refine((v) => v.email || v.phone, { message: "E-mail ou téléphone requis" });

const loginSchema = z.object({ identifier, password: z.string().min(1).max(128), device: z.string().max(120).optional() });

let DUMMY_HASH: string | undefined;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

async function issueSession(user: { _id: unknown; role: string }, device?: string) {
  const refreshToken = newRefreshToken();
  const session = await Session.create({
    userId: user._id,
    refreshHash: hashToken(refreshToken),
    device,
    expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000),
    lastUsedAt: new Date(),
  });
  const accessToken = signAccessToken({ sub: String(user._id), role: user.role as Role, sid: String(session._id) });
  return { accessToken, refreshToken, expiresIn: env.accessTokenTtlSec };
}

export function toMe(user: any, profile: any) {
  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email ?? null,
    phone: user.phone ?? null,
    role: user.role,
    profile: profile
      ? {
          subsystem: profile.subsystem,
          teachingLanguage: profile.teachingLanguage,
          schoolName: profile.schoolName ?? null,
          region: profile.region ?? null,
          division: profile.division ?? null,
          schoolYear: profile.schoolYear,
          assignments: profile.assignments ?? [],
          preferences: profile.preferences,
          onboardingCompleted: Boolean(profile.onboardingCompletedAt),
        }
      : null,
  };
}

authRouter.post(
  "/register",
  validate(registerSchema),
  ah(async (req, res) => {
    const { fullName, email, phone, password, device } = req.body as z.infer<typeof registerSchema>;
    const exists = await User.exists({ $or: [email ? { email } : null, phone ? { phone } : null].filter(Boolean) as object[] });
    if (exists) throw conflict("ACCOUNT_EXISTS", "Un compte existe déjà avec cet identifiant");
    const user = await User.create({ fullName, email, phone, passwordHash: await bcrypt.hash(password, 12), role: "teacher" });
    const tokens = await issueSession(user, device);
    res.status(201).json({ ...tokens, user: toMe(user, null) });
  })
);

authRouter.post(
  "/login",
  validate(loginSchema),
  ah(async (req, res) => {
    const { identifier, password, device } = req.body as z.infer<typeof loginSchema>;
    const id = identifier.toLowerCase();
    const user = await User.findOne(id.includes("@") ? { email: id } : { phone: identifier }).select(
      "+passwordHash +failedLogins +lockedUntil"
    );
    // Message identique que le compte existe ou non (pas d'énumération).
    const invalid = unauthorized("Identifiant ou mot de passe incorrect");
    if (!user || user.disabled) {
      // Temps de réponse constant même si le compte n'existe pas.
      DUMMY_HASH ??= await bcrypt.hash("pedago-dummy-password", 12);
      await bcrypt.compare(password, DUMMY_HASH);
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpError(429, "ACCOUNT_LOCKED", "Trop de tentatives. Réessaie dans quelques minutes.");
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCK_MS);
        user.failedLogins = 0;
      }
      await user.save();
      throw invalid;
    }
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();
    if (user.role !== "teacher") {
      await AuditLog.create({ actorId: user._id, action: "staff.login", ip: req.ip });
    }
    const profile = await TeacherProfile.findOne({ userId: user._id }).lean();
    const tokens = await issueSession(user, device);
    res.json({ ...tokens, user: toMe(user, profile) });
  })
);

/** Rotation : l'ancien jeton est invalidé ; une réutilisation révoque toute la session. */
authRouter.post(
  "/refresh",
  validate(z.object({ refreshToken: z.string().min(20).max(200) })),
  ah(async (req, res) => {
    const hash = hashToken(req.body.refreshToken);
    const refreshToken = newRefreshToken();
    // Rotation atomique : un même jeton ne peut servir qu'une fois, même en cas de requêtes simultanées.
    const session = await Session.findOneAndUpdate(
      { refreshHash: hash, revokedAt: null, expiresAt: { $gt: new Date() } },
      { refreshHash: hashToken(refreshToken), lastUsedAt: new Date(), $push: { usedHashes: { $each: [hash], $slice: -10 } } },
      { new: true }
    );
    if (!session) {
      // Réutilisation d'un ancien jeton : signe probable de vol → toute la session est révoquée.
      // Tolérance de 20 s : deux requêtes simultanées du même appareil ne sont pas une attaque.
      const stolen = await Session.findOneAndUpdate(
        { usedHashes: hash, revokedAt: null, lastUsedAt: { $lt: new Date(Date.now() - 20_000) } },
        { revokedAt: new Date() }
      );
      if (stolen) await AuditLog.create({ actorId: stolen.userId, action: "auth.refresh_reuse", target: String(stolen._id), ip: req.ip });
      throw unauthorized("Session expirée");
    }
    const user = await User.findById(session.userId).lean();
    if (!user || user.disabled) throw unauthorized("Session expirée");
    const accessToken = signAccessToken({ sub: String(user._id), role: user.role as Role, sid: String(session._id) });
    res.json({ accessToken, refreshToken, expiresIn: env.accessTokenTtlSec });
  })
);

authRouter.post(
  "/logout",
  requireAuth,
  ah(async (req, res) => {
    await Session.updateOne({ _id: (req as AuthedRequest).sessionId }, { revokedAt: new Date() });
    res.status(204).end();
  })
);

authRouter.get(
  "/sessions",
  requireAuth,
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const sessions = await Session.find({ userId: r.userId, revokedAt: null }).select("device lastUsedAt createdAt").lean();
    res.json(sessions.map((s) => ({ id: String(s._id), device: s.device, lastUsedAt: s.lastUsedAt, current: String(s._id) === r.sessionId })));
  })
);

authRouter.delete(
  "/sessions/:id",
  requireAuth,
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const out = await Session.updateOne({ _id: req.params.id, userId: r.userId }, { revokedAt: new Date() });
    if (!out.matchedCount) throw badRequest("NOT_FOUND", "Session introuvable");
    res.status(204).end();
  })
);
