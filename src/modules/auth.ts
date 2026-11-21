import { Router } from "express";
import crypto from "node:crypto";
import { sendMail, verificationEmail } from "../services/mail.js";
import { z } from "zod";
import { Session, User, TeacherProfile, AuditLog } from "../models/index.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ah, badRequest, conflict, unauthorized, HttpError } from "../utils/http-error.js";
import { hashToken, newRefreshToken, signAccessToken, signMfaChallenge, verifyMfaChallenge, type Role } from "../utils/jwt.js";
import { decryptSecret, encryptSecret, newRecoveryCodes, newTotpSecret, normalizeRecovery, otpauthUrl, verifyTotp } from "../utils/totp.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { deleteAccount } from "../services/account.js";
import { burnVerify, hashPassword, needsRehash, verifyPassword } from "../utils/password.js";

export const authRouter = Router();

const password = z.string().min(8, "8 caractères minimum").max(128);
const identifier = z.string().trim().min(3).max(160);

const registerSchema = z
  .object({
    fullName: z.string().trim().min(2, "Nom trop court").max(120),
    // L'e-mail est obligatoire : il est vérifié par code et sert à récupérer le compte.
    email: z.string().trim().toLowerCase().email("E-mail invalide"),
    phone: z.string().trim().regex(/^\+?\d{8,15}$/, "Téléphone invalide").optional(),
    password,
    passwordConfirm: z.string().max(128),
    device: z.string().max(120).optional(),
  })
  .refine((v) => v.password === v.passwordConfirm, { message: "Les deux mots de passe ne correspondent pas", path: ["passwordConfirm"] });

const loginSchema = z.object({ identifier, password: z.string().min(1).max(128), device: z.string().max(120).optional() });

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

async function issueSession(user: { _id: unknown; role: string; emailVerified?: boolean | null }, device?: string, mfa = false) {
  const refreshToken = newRefreshToken();
  const session = await Session.create({
    userId: user._id,
    refreshHash: hashToken(refreshToken),
    device,
    mfa,
    expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000),
    lastUsedAt: new Date(),
  });
  const accessToken = signAccessToken({ sub: String(user._id), role: user.role as Role, sid: String(session._id), ev: Boolean(user.emailVerified), mfa });
  return { accessToken, refreshToken, expiresIn: env.accessTokenTtlSec };
}

export function toMe(user: any, profile: any) {
  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email ?? null,
    phone: user.phone ?? null,
    role: user.role,
    emailVerified: Boolean(user.emailVerified),
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

const CODE_TTL_MS = 15 * 60_000;
const CODE_MAX_ATTEMPTS = 5;

/**
 * Génère un code à 6 chiffres (stocké haché) et l'envoie par e-mail. Renvoie le code (écho en développement)
 * et si l'envoi a réussi : un service d'e-mail en panne ne doit pas faire échouer l'inscription.
 */
async function sendVerificationCode(userId: string): Promise<{ code: string | null; sent: boolean }> {
  const user = await User.findById(userId).select("+emailCodeSentAt");
  if (!user?.email || user.emailVerified) return { code: null, sent: false };
  if (user.emailCodeSentAt && Date.now() - user.emailCodeSentAt.getTime() < 45_000) {
    throw new HttpError(429, "CODE_TOO_SOON", "Patiente quelques secondes avant de redemander un code");
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  user.emailCodeHash = hashToken(code + userId);
  user.emailCodeExpiresAt = new Date(Date.now() + CODE_TTL_MS);
  user.emailCodeAttempts = 0;
  user.emailCodeSentAt = new Date();
  await user.save();
  const mail = verificationEmail(user.fullName, code);
  try {
    await sendMail(user.email, mail.subject, mail.html, mail.text);
    return { code, sent: true };
  } catch (err) {
    logger.warn({ err: (err as Error).message, userId }, "Code de vérification non envoyé");
    return { code, sent: false };
  }
}

authRouter.post(
  "/verify-email",
  requireAuth,
  validate(z.object({ code: z.string().regex(/^\d{6}$/, "Code à 6 chiffres attendu") })),
  ah(async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const user = await User.findById(userId).select("+emailCodeHash +emailCodeExpiresAt +emailCodeAttempts");
    if (!user) throw unauthorized();
    if (user.emailVerified) return res.json({ verified: true });
    if (!user.emailCodeHash || !user.emailCodeExpiresAt || user.emailCodeExpiresAt < new Date()) {
      throw badRequest("CODE_EXPIRED", "Code expiré : demande un nouveau code");
    }
    if ((user.emailCodeAttempts ?? 0) >= CODE_MAX_ATTEMPTS) throw badRequest("CODE_LOCKED", "Trop d'essais : demande un nouveau code");
    const ok = crypto.timingSafeEqual(Buffer.from(user.emailCodeHash), Buffer.from(hashToken(req.body.code + userId)));
    if (!ok) {
      user.emailCodeAttempts = (user.emailCodeAttempts ?? 0) + 1;
      await user.save();
      throw badRequest("CODE_INVALID", `Code incorrect (${CODE_MAX_ATTEMPTS - user.emailCodeAttempts} essai(s) restant(s))`);
    }
    user.emailVerified = true;
    user.emailCodeHash = undefined;
    user.emailCodeExpiresAt = undefined;
    await user.save();
    // Nouveau jeton d'accès portant la vérification, utilisable immédiatement.
    const r = req as AuthedRequest;
    const accessToken = signAccessToken({ sub: r.userId, role: r.role, sid: r.sessionId, ev: true, mfa: r.mfa });
    res.json({ verified: true, accessToken, expiresIn: env.accessTokenTtlSec });
  })
);

authRouter.post(
  "/resend-code",
  requireAuth,
  ah(async (req, res) => {
    const { code, sent } = await sendVerificationCode((req as AuthedRequest).userId);
    if (code && !sent && !env.devEchoCodes) throw new HttpError(502, "MAIL_FAILED", "Le code n'a pas pu être envoyé. Vérifie ton adresse ou réessaie dans un instant.");
    res.json({ sent, ...(env.devEchoCodes && code ? { devCode: code } : {}) });
  })
);

authRouter.post(
  "/register",
  validate(registerSchema),
  ah(async (req, res) => {
    const { fullName, email, phone, password, device } = req.body as z.infer<typeof registerSchema>;
    const exists = await User.exists({ $or: [email ? { email } : null, phone ? { phone } : null].filter(Boolean) as object[] });
    if (exists) throw conflict("ACCOUNT_EXISTS", "Un compte existe déjà avec cet identifiant");
    const user = await User.create({ fullName, email, phone, passwordHash: await hashPassword(password), role: "teacher" });
    // Le compte existe et la personne est connectée même si l'e-mail n'est pas parti : elle redemande le code.
    const { code, sent } = await sendVerificationCode(String(user._id));
    const tokens = await issueSession(user, device);
    res.status(201).json({ ...tokens, user: toMe(user, null), mailSent: sent, ...(env.devEchoCodes && code ? { devCode: code } : {}) });
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
      await burnVerify(password);
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpError(429, "ACCOUNT_LOCKED", "Trop de tentatives. Réessaie dans quelques minutes.");
    }
    const ok = await verifyPassword(user.passwordHash, password);
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
    // Migration transparente vers Argon2id (le mot de passe en clair n'est disponible qu'ici).
    if (needsRehash(user.passwordHash)) user.passwordHash = await hashPassword(password);
    await user.save();
    if (user.role !== "teacher") {
      await AuditLog.create({ actorId: user._id, action: "staff.login", ip: req.ip });
      // Mot de passe correct : il reste le code de l'application d'authentification.
      if (user.mfaEnabled) return res.json({ mfaRequired: true, mfaToken: signMfaChallenge(String(user._id)) });
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
    const accessToken = signAccessToken({ sub: String(user._id), role: user.role as Role, sid: String(session._id), ev: Boolean(user.emailVerified), mfa: Boolean(session.mfa) });
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

/* ───────────── Double authentification (TOTP) ───────────── */

const MFA_MAX_FAILED = 5;

/** Étape 2 de la connexion : code à 6 chiffres, ou un code de secours à usage unique. */
authRouter.post(
  "/mfa/verify",
  validate(
    z.object({
      mfaToken: z.string().min(20).max(800),
      code: z.string().trim().max(12).optional(),
      recoveryCode: z.string().trim().max(20).optional(),
      device: z.string().max(120).optional(),
    })
  ),
  ah(async (req, res) => {
    let userId: string;
    try {
      userId = verifyMfaChallenge(req.body.mfaToken);
    } catch {
      throw unauthorized("Étape expirée : reconnecte-toi");
    }
    const user = await User.findById(userId).select("+mfaSecretEnc +mfaLastStep +mfaRecoveryHashes +mfaFailed +lockedUntil");
    if (!user || user.disabled || !user.mfaEnabled || !user.mfaSecretEnc) throw unauthorized("Étape expirée : reconnecte-toi");
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpError(429, "ACCOUNT_LOCKED", "Trop de tentatives. Réessaie dans quelques minutes.");

    let ok = false;
    let usedRecovery = false;
    if (req.body.code) {
      const step = verifyTotp(decryptSecret(user.mfaSecretEnc), req.body.code, user.mfaLastStep ?? -1);
      if (step !== null) {
        ok = true;
        user.mfaLastStep = step; // un même code ne sert qu'une fois
      }
    } else if (req.body.recoveryCode) {
      const h = hashToken(normalizeRecovery(req.body.recoveryCode) + userId);
      const left = (user.mfaRecoveryHashes ?? []).filter((x) => x !== h);
      if (left.length < (user.mfaRecoveryHashes ?? []).length) {
        ok = true;
        usedRecovery = true;
        user.mfaRecoveryHashes = left;
      }
    }
    if (!ok) {
      user.mfaFailed = (user.mfaFailed ?? 0) + 1;
      if (user.mfaFailed >= MFA_MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCK_MS);
        user.mfaFailed = 0;
      }
      await user.save();
      throw unauthorized("Code incorrect");
    }
    user.mfaFailed = 0;
    await user.save();
    await AuditLog.create({ actorId: user._id, action: usedRecovery ? "staff.mfa_recovery_used" : "staff.mfa_ok", ip: req.ip });
    const profile = await TeacherProfile.findOne({ userId: user._id }).lean();
    const tokens = await issueSession(user, req.body.device, true);
    res.json({ ...tokens, user: toMe(user, profile), ...(usedRecovery ? { recoveryCodesLeft: user.mfaRecoveryHashes?.length ?? 0 } : {}) });
  })
);

/** Activation, étape 1 : un secret provisoire (QR code / clé à saisir dans l'application d'authentification). */
authRouter.post(
  "/mfa/setup",
  requireAuth,
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const user = await User.findById(r.userId);
    if (!user) throw unauthorized();
    if (user.mfaEnabled) throw conflict("MFA_ALREADY_ENABLED", "La double authentification est déjà active");
    const secret = newTotpSecret();
    user.mfaPendingEnc = encryptSecret(secret);
    await user.save();
    res.json({ secret, otpauthUrl: otpauthUrl(secret, user.email ?? user.fullName) });
  })
);

/** Activation, étape 2 : le premier code prouve que l'application est bien configurée. */
authRouter.post(
  "/mfa/enable",
  requireAuth,
  validate(z.object({ code: z.string().trim().regex(/^\d{6}$/,"Code à 6 chiffres attendu") })),
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const user = await User.findById(r.userId).select("+mfaPendingEnc");
    if (!user?.mfaPendingEnc) throw badRequest("MFA_NOT_STARTED", "Recommence l'activation");
    const secret = decryptSecret(user.mfaPendingEnc);
    const step = verifyTotp(secret, req.body.code);
    if (step === null) throw badRequest("CODE_INVALID", "Code incorrect : vérifie l'heure du téléphone");
    const recoveryCodes = newRecoveryCodes();
    user.mfaEnabled = true;
    user.mfaSecretEnc = encryptSecret(secret);
    user.mfaPendingEnc = undefined;
    user.mfaLastStep = step;
    user.mfaRecoveryHashes = recoveryCodes.map((c) => hashToken(normalizeRecovery(c) + r.userId));
    await user.save();
    // Les autres sessions, ouvertes sans le second facteur, sont fermées.
    await Session.updateMany({ userId: r.userId, _id: { $ne: r.sessionId }, revokedAt: null }, { revokedAt: new Date() });
    await Session.updateOne({ _id: r.sessionId }, { mfa: true });
    await AuditLog.create({ actorId: user._id, action: "staff.mfa_enabled", ip: req.ip });
    const accessToken = signAccessToken({ sub: r.userId, role: r.role, sid: r.sessionId, ev: Boolean(user.emailVerified), mfa: true });
    res.json({ enabled: true, recoveryCodes, accessToken, expiresIn: env.accessTokenTtlSec });
  })
);

/** Suppression définitive de son compte (enseignant), confirmée par le mot de passe. */
authRouter.delete(
  "/me",
  requireAuth,
  validate(z.object({ password: z.string().min(1).max(128) })),
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    if (r.role !== "teacher") throw new HttpError(403, "STAFF_ACCOUNT", "Un compte de l'équipe est supprimé par un administrateur");
    const user = await User.findById(r.userId).select("+passwordHash");
    if (!user) throw unauthorized();
    if (!(await verifyPassword(user.passwordHash, req.body.password))) throw badRequest("WRONG_PASSWORD", "Mot de passe incorrect");
    await deleteAccount(r.userId, req.ip);
    res.status(204).end();
  })
);
