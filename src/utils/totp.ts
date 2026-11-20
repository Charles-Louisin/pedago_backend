import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Double authentification par code temporaire (TOTP, RFC 6238) : compatible Google Authenticator,
 * Microsoft Authenticator, Aegis… Code à 6 chiffres, pas de 30 s, tolérance d'un pas d'horloge.
 */
const STEP = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Base32 invalide");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, "0");
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP);
}

/**
 * Vérifie un code ; renvoie le pas accepté (pour refuser qu'un même code serve deux fois), sinon null.
 * `lastStep` : dernier pas déjà utilisé par ce compte.
 */
export function verifyTotp(secret: string, code: string, lastStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = currentStep(now);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (step <= lastStep) continue;
    const expected = totpAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string) {
  const label = encodeURIComponent(`PEDAGO:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=PEDAGO&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

/* Le secret est chiffré en base (AES-256-GCM), avec une clé dérivée du secret serveur. */
function key() {
  return Buffer.from(crypto.hkdfSync("sha256", env.jwtSecret, "pedago", "mfa-secret-v1", 32));
}

export function encryptSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(enc: string) {
  const [iv, tag, data] = enc.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/** Codes de secours à usage unique (format XXXX-XXXX), stockés hachés. */
export function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export function normalizeRecovery(code: string) {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}
