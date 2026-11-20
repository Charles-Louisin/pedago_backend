import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import { LessonInstance, Resource, User } from "../src/models/index.js";
import bcrypt from "bcryptjs";
import { currentStep, totpAt } from "../src/utils/totp.js";

let mongo: MongoMemoryServer;
let server: Server;
let base = "";

async function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const login = (identifier: string, password: string) => call("/auth/login", { method: "POST", body: { identifier, password } });

/** Équipe : active la double authentification à la première connexion, puis réutilise la session. */
const staff = new Map<string, string>();
async function staffToken(email: string, password: string) {
  if (staff.has(email)) return staff.get(email)!;
  const first = await login(email, password);
  const setup = await call("/auth/mfa/setup", { method: "POST", token: first.body.accessToken });
  const on = await call("/auth/mfa/enable", { method: "POST", token: first.body.accessToken, body: { code: totpAt(setup.body.secret, currentStep()) } });
  assert.equal(on.status, 200);
  staff.set(email, on.body.accessToken);
  return on.body.accessToken as string;
}

before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-api-test"));
  await seedDatabase();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("inscription : confirmation du mot de passe obligatoire", async () => {
  const r = await call("/auth/register", { method: "POST", body: { fullName: "Test Confirm", email: "confirm@pedago.test", password: "Pedago-Test-2026!", passwordConfirm: "autre" } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /correspondent/);
});

test("rotation du jeton de rafraîchissement et détection de réutilisation", async () => {
  const first = await login("enseignant@pedago.test", "Pedago-Enseignant-2026!");
  assert.equal(first.status, 200);
  const r1 = await call("/auth/refresh", { method: "POST", body: { refreshToken: first.body.refreshToken } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, first.body.refreshToken);
  // L'ancien jeton ne sert plus.
  const replay = await call("/auth/refresh", { method: "POST", body: { refreshToken: first.body.refreshToken } });
  assert.equal(replay.status, 401);
});

test("un enseignant ne peut ni lire l'admin ni toucher aux séances d'un autre", async () => {
  const t = (await login("enseignant@pedago.test", "Pedago-Enseignant-2026!")).body.accessToken;
  assert.equal((await call("/admin/stats", { token: t })).status, 403);
  const reg = await call("/auth/register", { method: "POST", body: { fullName: "Autre Enseignant", email: "autre@pedago.test", password: "Pedago-Autre-2026!", passwordConfirm: "Pedago-Autre-2026!" } });
  assert.equal(reg.status, 201);
  // Tant que l'e-mail n'est pas confirmé, l'application est fermée.
  assert.equal((await call("/teacher/catchup", { token: reg.body.accessToken })).status, 403);
  assert.equal((await call("/auth/verify-email", { method: "POST", token: reg.body.accessToken, body: { code: "000000" } })).status, 400);
  const ver = await call("/auth/verify-email", { method: "POST", token: reg.body.accessToken, body: { code: reg.body.devCode } });
  assert.equal(ver.status, 200);
  reg.body.accessToken = ver.body.accessToken;
  const owner = await User.findOne({ email: "enseignant@pedago.test" });
  const lesson = await LessonInstance.create({ teacherId: owner!._id, classLevel: "CP", subjectCode: "MATH", nodeId: new mongoose.Types.ObjectId(), date: "2026-11-23" });
  const sync = await call("/teacher/sync/events", {
    method: "POST",
    token: reg.body.accessToken,
    body: { events: [{ opId: "op-intrus-0001", lessonId: String(lesson._id), status: "done", recordedAt: new Date().toISOString() }] },
  });
  assert.equal(sync.body.acks[0].status, "rejected");
  assert.equal((await LessonInstance.findById(lesson._id))!.status, "planned");
});

test("synchronisation idempotente : un même opId n'est appliqué qu'une fois", async () => {
  const t = (await login("enseignant@pedago.test", "Pedago-Enseignant-2026!")).body.accessToken;
  const plan = await call("/teacher/planning?from=2026-11-23&to=2026-11-27", { token: t });
  assert.equal(plan.status, 200);
  const lesson = plan.body.lessons.find((l: { node: unknown }) => l.node);
  const lessonId = lesson.id;
  const ev = { opId: "op-double-0001", lessonId, status: "missed", recordedAt: new Date().toISOString() };
  const res = await call("/teacher/sync/events", { method: "POST", token: t, body: { events: [ev, ev] } });
  assert.deepEqual(res.body.acks.map((a: { status: string }) => a.status), ["applied", "duplicate"]);
  const catchup = await call("/teacher/catchup", { token: t });
  assert.equal(catchup.body.filter((c: { title: string }) => c.title === lesson.node.title).length, 1);
});

test("principe des quatre yeux et publication réservée à l'admin", async () => {
  const admin = await staffToken("admin@pedago.test", "Pedago-Admin-2026!");
  const reviewer = await staffToken("relecteur@pedago.test", "Pedago-Relecteur-2026!");
  const r = await Resource.findOne({ status: "PUBLISHED" });
  const id = String(r!._id);
  assert.equal((await call(`/admin/resources/${id}/revise`, { method: "POST", token: reviewer })).status, 403);
  assert.equal((await call(`/admin/resources/${id}/revise`, { method: "POST", token: admin })).status, 200);
  // L'auteur de la révision ne peut pas l'approuver lui-même.
  const self = await call(`/admin/resources/${id}/transition`, { method: "POST", token: admin, body: { to: "APPROVED" } });
  assert.equal(self.status, 403);
  assert.equal((await call(`/admin/resources/${id}/transition`, { method: "POST", token: reviewer, body: { to: "APPROVED" } })).status, 200);
  assert.equal((await call(`/admin/resources/${id}/transition`, { method: "POST", token: reviewer, body: { to: "PUBLISHED" } })).status, 403);
  assert.equal((await call(`/admin/resources/${id}/transition`, { method: "POST", token: admin, body: { to: "PUBLISHED" } })).status, 200);
});

test("sources : liste blanche, pas d'URL arbitraire ni de javascript:", async () => {
  const admin = await staffToken("admin@pedago.test", "Pedago-Admin-2026!");
  const post = (body: object) => call("/admin/sources", { method: "POST", token: admin, body: { title: "Test source", issuer: "MINEDUB", ...body } });
  assert.equal((await post({ url: "https://evil.example.com/x.pdf" })).status, 400);
  assert.equal((await post({ fileUrl: "http://127.0.0.1:5100/api/v1/health" })).status, 400);
  assert.equal((await post({ url: "javascript:alert(1)" })).status, 400);
  assert.equal((await post({ url: "https://www.minedub.cm/programme.pdf" })).status, 201);
});

test("désactiver un compte ferme ses sessions immédiatement", async () => {
  const admin = await staffToken("admin@pedago.test", "Pedago-Admin-2026!");
  const t = (await login("autre@pedago.test", "Pedago-Autre-2026!")).body.accessToken;
  assert.equal((await call("/teacher/me", { token: t })).status, 200);
  const other = await User.findOne({ email: "autre@pedago.test" });
  assert.equal((await call(`/admin/users/${other!._id}`, { method: "PATCH", token: admin, body: { disabled: true } })).status, 200);
  assert.equal((await call("/teacher/me", { token: t })).status, 401);
});

test("équipe : double authentification obligatoire, codes à usage unique, secours, renouvellement", async () => {
  await User.create({ fullName: "Admin 2FA", email: "mfa@pedago.test", role: "admin", emailVerified: true, passwordHash: await bcrypt.hash("Pedago-Mfa-2026!", 12) });
  const first = await login("mfa@pedago.test", "Pedago-Mfa-2026!");
  assert.equal(first.status, 200);
  // Ancien hachage bcrypt converti en Argon2id dès la connexion.
  assert.match((await User.findOne({ email: "mfa@pedago.test" }).select("+passwordHash"))!.passwordHash, /^\$argon2id\$/);
  // Sans 2FA : aucune action d'administration.
  const blocked = await call("/admin/stats", { token: first.body.accessToken });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "MFA_REQUIRED");

  const setup = await call("/auth/mfa/setup", { method: "POST", token: first.body.accessToken });
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/PEDAGO/);
  assert.equal((await call("/auth/mfa/enable", { method: "POST", token: first.body.accessToken, body: { code: "000000" } })).status, 400);
  const step = currentStep();
  const on = await call("/auth/mfa/enable", { method: "POST", token: first.body.accessToken, body: { code: totpAt(setup.body.secret, step) } });
  assert.equal(on.status, 200);
  assert.equal(on.body.recoveryCodes.length, 8);
  assert.equal((await call("/admin/stats", { token: on.body.accessToken })).status, 200);

  // Connexion suivante : le mot de passe seul ne suffit plus.
  const pw = await login("mfa@pedago.test", "Pedago-Mfa-2026!");
  assert.equal(pw.body.mfaRequired, true);
  assert.equal(pw.body.accessToken, undefined);
  // Le code déjà utilisé à l'activation est refusé (pas de rejeu).
  assert.equal((await call("/auth/mfa/verify", { method: "POST", body: { mfaToken: pw.body.mfaToken, code: totpAt(setup.body.secret, step) } })).status, 401);
  const ok = await call("/auth/mfa/verify", { method: "POST", body: { mfaToken: pw.body.mfaToken, code: totpAt(setup.body.secret, step + 1) } });
  assert.equal(ok.status, 200);
  // Le renouvellement conserve la 2FA.
  const refreshed = await call("/auth/refresh", { method: "POST", body: { refreshToken: ok.body.refreshToken } });
  assert.equal((await call("/admin/stats", { token: refreshed.body.accessToken })).status, 200);

  // Code de secours : une seule fois.
  const pw2 = await login("mfa@pedago.test", "Pedago-Mfa-2026!");
  const rec = await call("/auth/mfa/verify", { method: "POST", body: { mfaToken: pw2.body.mfaToken, recoveryCode: on.body.recoveryCodes[0].toLowerCase() } });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.recoveryCodesLeft, 7);
  const pw3 = await login("mfa@pedago.test", "Pedago-Mfa-2026!");
  assert.equal((await call("/auth/mfa/verify", { method: "POST", body: { mfaToken: pw3.body.mfaToken, recoveryCode: on.body.recoveryCodes[0] } })).status, 401);
});
