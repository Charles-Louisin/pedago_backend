import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

export type Role = "teacher" | "admin";
/** ev : e-mail vérifié ; mfa : session ouverte avec la double authentification. */
export type AccessPayload = { sub: string; role: Role; sid: string; ev?: boolean; mfa?: boolean };

export function signAccessToken(payload: AccessPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.accessTokenTtlSec, issuer: "pedago-api", algorithm: "HS256" });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.jwtSecret, { issuer: "pedago-api", algorithms: ["HS256"] }) as AccessPayload & jwt.JwtPayload;
}

/** Jeton de rafraîchissement opaque : seul son empreinte SHA-256 est stockée en base. */
export function newRefreshToken() {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Jeton intermédiaire (5 min) entre le mot de passe et le code de double authentification. */
export function signMfaChallenge(userId: string) {
  return jwt.sign({ sub: userId, purpose: "mfa" }, env.jwtSecret, { expiresIn: 300, issuer: "pedago-api", audience: "mfa", algorithm: "HS256" });
}

export function verifyMfaChallenge(token: string) {
  const p = jwt.verify(token, env.jwtSecret, { issuer: "pedago-api", audience: "mfa", algorithms: ["HS256"] }) as jwt.JwtPayload;
  if (p.purpose !== "mfa" || typeof p.sub !== "string") throw new Error("Jeton invalide");
  return p.sub;
}
