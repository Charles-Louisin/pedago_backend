import { hash, verify } from "@node-rs/argon2";
import bcrypt from "bcryptjs";

/**
 * Mots de passe : Argon2id (recommandation OWASP : 19 Mio de mémoire, 2 passes, 1 fil).
 * Les anciens hachages bcrypt restent vérifiables et sont convertis à la connexion suivante.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string) {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(stored: string, plain: string) {
  if (stored.startsWith("$argon2")) return verify(stored, plain);
  if (stored.startsWith("$2")) return bcrypt.compare(plain, stored);
  return false;
}

/** Vrai si le hachage doit être refait (ancien bcrypt, ou paramètres Argon2 plus faibles qu'aujourd'hui). */
export function needsRehash(stored: string) {
  if (!stored.startsWith("$argon2id$")) return true;
  const m = /m=(\d+),t=(\d+),p=(\d+)/.exec(stored);
  return !m || Number(m[1]) < OPTIONS.memoryCost || Number(m[2]) < OPTIONS.timeCost;
}

let dummy: Promise<string> | undefined;
/** Vérification factice : même temps de réponse qu'un compte existe ou non (pas d'énumération). */
export async function burnVerify(plain: string) {
  dummy ??= hashPassword("pedago-dummy-password");
  await verify(await dummy, plain).catch(() => false);
}
