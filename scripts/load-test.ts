import crypto from "node:crypto";
import os from "node:os";
import autocannon from "autocannon";
import { hashPassword, verifyPassword } from "../src/utils/password.js";

/**
 * Tests de charge réalistes (parcours enseignant) : npm run load-test -- <url de l'API> [secondes] [connexions]
 * À lancer contre une instance de test (jamais la production) avec RATE_LIMIT_MAX=0,
 * sinon le limiteur de débit renvoie des 429 et fausse les mesures.
 * Compte utilisé : SEED_TEACHER_EMAIL / SEED_TEACHER_PASSWORD (valeurs du seed par défaut).
 */
const [baseArg, secArg, connArg] = process.argv.slice(2);
const base = (baseArg || "http://127.0.0.1:5199/api/v1").replace(/\/$/, "");
const duration = Number(secArg || 15);
const connections = Number(connArg || 50);
const { origin, pathname: P } = new URL(base);
const email = process.env.SEED_TEACHER_EMAIL || "enseignant@pedago.test";
const password = process.env.SEED_TEACHER_PASSWORD || "Pedago-Enseignant-2026!";

async function json(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

type Row = { scenario: string; rps: number; p50: number; p97_5: number; p99: number; max: number; errors: number; non2xx: number; requests: number };
const rows: Row[] = [];

async function run(scenario: string, { path, ...opts }: Partial<autocannon.Options> & { path?: string }) {
  const r = await autocannon({ url: origin + (path ?? ""), duration, connections, ...opts } as autocannon.Options);
  rows.push({
    scenario,
    rps: Math.round(r.requests.average),
    p50: r.latency.p50,
    p97_5: r.latency.p97_5,
    p99: r.latency.p99,
    max: r.latency.max,
    errors: r.errors + r.timeouts,
    non2xx: r.non2xx,
    requests: r.requests.total,
  });
  console.log(`✓ ${scenario}`);
}

const login = await json("/auth/login", { method: "POST", body: JSON.stringify({ identifier: email, password, device: "Test de charge" }) });
const auth = { Authorization: `Bearer ${login.accessToken}`, "Content-Type": "application/json" };
const me = await json("/teacher/me", { headers: auth });
const classLevel: string = me.profile.assignments[0].classLevel;
const subject: string = me.profile.assignments[0].subjects[0];
const today = new Date().toISOString().slice(0, 10);
const in3w = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
const plan = await json(`/teacher/planning?from=${today}&to=${in3w}`, { headers: auth });
const lessonIds: string[] = plan.lessons.map((l: { id: string }) => l.id);
const list = await json(`/library/resources?classLevel=${classLevel}&subjectCode=${subject}&limit=25`, { headers: auth });
const resourceIds: string[] = list.items.map((i: { id: string }) => i.id);
if (!lessonIds.length || !resourceIds.length) throw new Error("Données insuffisantes (planning ou bibliothèque vide)");
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

console.log(`API ${base} · ${connections} connexions · ${duration} s par scénario · ${os.cpus().length} cœurs\n`);

await run("Accueil : programme sur 3 semaines", { path: `${P}/teacher/planning?from=${today}&to=${in3w}`, headers: auth });
await run("Recherche dans la bibliothèque", { path: `${P}/library/resources?classLevel=${classLevel}&subjectCode=${subject}&q=nombres&limit=25`, headers: auth });
await run("Ouverture d'une fiche", { headers: auth, requests: [{ setupRequest: (req) => ({ ...req, method: "GET", path: `${P}/library/resources/${pick(resourceIds)}` }) }] });
await run("Manifeste de téléchargement (année)", { method: "POST", path: `${P}/library/manifest`, headers: auth, body: JSON.stringify({ scope: "year", classLevel }) });
await run("Synchronisation de bilans hors ligne (écritures)", {
  method: "POST",
  headers: auth,
  requests: [
    {
      setupRequest: (req) => ({
        ...req,
        method: "POST",
        path: `${P}/teacher/sync/events`,
        body: JSON.stringify({
          events: [{ opId: crypto.randomUUID(), lessonId: pick(lessonIds), status: "done", durationMin: 45, recordedAt: new Date().toISOString() }],
        }),
      }),
    },
  ],
});
await run("Grille de progression annuelle", { path: `${P}/teacher/progress/grid?classLevel=${classLevel}`, headers: auth });

// Connexions : le coût est le hachage Argon2id (volontairement lent). Mesure directe, sans contourner le limiteur.
const hash = await hashPassword(password);
const n = 64;
const t0 = Date.now();
await Promise.all(Array.from({ length: n }, () => verifyPassword(hash, password)));
const loginPerSec = Math.round((n / (Date.now() - t0)) * 1000);

console.log("\nScénario".padEnd(52) + "req/s".padStart(8) + "p50".padStart(7) + "p97.5".padStart(8) + "p99".padStart(7) + "max".padStart(7) + "  erreurs");
for (const r of rows) {
  console.log(
    r.scenario.padEnd(51) + String(r.rps).padStart(8) + `${r.p50}`.padStart(7) + `${r.p97_5}`.padStart(8) + `${r.p99}`.padStart(7) + `${r.max}`.padStart(7) + `  ${r.errors + r.non2xx}/${r.requests}`
  );
}
console.log(`\nVérifications de mot de passe Argon2id : ~${loginPerSec}/s sur ce processus (latences en ms).`);
if (rows.some((r) => r.errors + r.non2xx > 0)) process.exitCode = 1;
