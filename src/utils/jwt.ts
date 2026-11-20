import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

export type Role = "teacher" | "reviewer" | "admin";
/** ev : e-mail vérifié (évite une lecture en base à chaque requête). */
export type AccessPayload = { sub: string; role: Role; sid: string; ev?: boolean };

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
