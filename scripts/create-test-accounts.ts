/**
 * Crée (ou réinitialise) des comptes de test frais dans la base LOCALE de développement :
 *  - un administrateur (tableau de bord), double authentification activée ;
 *  - un enseignant (app mobile), e-mail vérifié, configuration à faire.
 *
 * Mots de passe et secret de double authentification sont générés au hasard et écrits dans `.env`
 * (fichier local, ignoré par git) : TEST_ADMIN_* et TEST_TEACHER_*. Rien n'est affiché à l'écran.
 * Le script refuse toute base qui n'est pas la base locale (jamais Atlas ni la production) et tout
 * compte hors du domaine de test `@pedago.test`.
 *
 * Prérequis : l'API locale tourne (npm run dev), elle ouvre la base locale sur le port 27027.
 * Usage : npx tsx scripts/create-test-accounts.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { User } from "../src/models/index.js";
import { hashPassword } from "../src/utils/password.js";
import { currentStep, totpAt } from "../src/utils/totp.js";

const DB = process.env.TEST_DB_URI ?? "mongodb://127.0.0.1:27027/pedago";
const API = process.env.TEST_API_URL ?? "http://localhost:5000/api/v1";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(DB)) {
  console.error("Refusé : ce script n'écrit que dans la base locale de développement (127.0.0.1).");
  process.exit(1);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(API)) {
  console.error("Refusé : l'API doit être l'API locale.");
  process.exit(1);
}

const ACCOUNTS = [
  { key: "ADMIN", email: "admin.essai@pedago.test", fullName: "Admin Essai", role: "admin" as const },
  { key: "TEACHER", email: "enseignant.essai@pedago.test", fullName: "Enseignant Essai", role: "teacher" as const },
];

/** Mot de passe solide et lisible : 4 groupes, majuscules, minuscules, chiffres et un symbole. */
const password = () => `Essai-${crypto.randomBytes(9).toString("base64url")}-${crypto.randomInt(10, 99)}!`;

async function call(p: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${p}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Écrit ou remplace des variables dans `.env` sans toucher au reste. */
function writeEnv(values: Record<string, string>) {
  const file = path.resolve(".env");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  }
  fs.writeFileSync(file, text);
}

await mongoose.connect(DB);
const out: Record<string, string> = {};
try {
  for (const a of ACCOUNTS) {
    if (!a.email.endsWith("@pedago.test")) throw new Error("Compte hors domaine de test");
    const pw = password();
    // Compte neuf, ou remis à zéro : mot de passe, double authentification et verrouillage effacés.
    await User.updateOne(
      { email: a.email },
      {
        $set: { fullName: a.fullName, role: a.role, passwordHash: await hashPassword(pw), disabled: false, emailVerified: true, mfaEnabled: false, failedLogins: 0 },
        $unset: { mfaSecretEnc: "", mfaPendingEnc: "", mfaRecoveryHashes: "", mfaLastStep: "", lockedUntil: "" },
      },
      { upsert: true }
    );
    out[`TEST_${a.key}_EMAIL`] = a.email;
    out[`TEST_${a.key}_PASSWORD`] = pw;

    if (a.role === "admin") {
      // Double authentification activée par l'API elle-même (même chiffrement que dans l'app).
      const login = await call("/auth/login", { method: "POST", body: { identifier: a.email, password: pw } });
      if (login.status !== 200) throw new Error(`Connexion admin refusée par l'API locale (${login.status}) : l'API tourne-t-elle sur ${API} ?`);
      const setup = await call("/auth/mfa/setup", { method: "POST", token: login.body.accessToken });
      if (!setup.body.secret) throw new Error("Préparation de la double authentification impossible");
      const on = await call("/auth/mfa/enable", { method: "POST", token: login.body.accessToken, body: { code: totpAt(setup.body.secret, currentStep()) } });
      if (on.status !== 200) throw new Error(`Activation de la double authentification refusée (${on.status})`);
      out.TEST_ADMIN_TOTP_SECRET = setup.body.secret;
    }
  }
  writeEnv(out);
  console.log(`Comptes prêts : ${ACCOUNTS.map((a) => `${a.email} (${a.role})`).join(", ")}.`);
  console.log("Identifiants et secret de double authentification écrits dans .env (TEST_ADMIN_*, TEST_TEACHER_*).");
} finally {
  await mongoose.disconnect();
}
