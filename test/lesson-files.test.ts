import "./helpers/offline-env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import { GeneratedDocument, LessonInstance } from "../src/models/index.js";
import { addDays } from "../src/utils/dates.js";

/** Fiches prêtes des séances : préparation à l'avance, taille exacte, nouvelle version après modification, report. */
let mongo: MongoMemoryServer;
let server: Server;
let base = "";
let token = "";
const today = new Date().toISOString().slice(0, 10);

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-lesson-files-test"));
  await seedDatabase();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call("/auth/login", { method: "POST", body: { identifier: "enseignant@pedago.test", password: "Pedago-Enseignant-2026!" } });
  token = login.body.accessToken;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("fiches des séances : préparées à l'avance, taille exacte, réutilisées tant que rien ne change", async () => {
  const to = addDays(today, 6);
  await call(`/teacher/planning?from=${today}&to=${to}`);
  const first = await call(`/teacher/lessons/files?from=${today}&to=${to}&today=${today}`);
  assert.equal(first.status, 200);
  assert.ok(first.body.length > 0);
  // Préparation en arrière-plan : quelques instants plus tard, toutes les fiches ont leur taille.
  let files = first.body;
  for (let i = 0; i < 60 && files.some((f: any) => f.status !== "ready"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    files = (await call(`/teacher/lessons/files?from=${today}&to=${to}&today=${today}`)).body;
  }
  assert.ok(files.every((f: any) => f.status === "ready" && f.sizeBytes > 1000 && f.url), JSON.stringify(files.slice(0, 2)));
  const count = await GeneratedDocument.countDocuments({ fingerprint: { $ne: null } });
  // Redemander ne recompose rien.
  await call(`/teacher/lessons/files?from=${today}&to=${to}&today=${today}`);
  assert.equal(await GeneratedDocument.countDocuments({ fingerprint: { $ne: null } }), count);
});

test("modifier une fiche : nouvelle version, l'ancienne est effacée ; autre enseignant refusé", async () => {
  const lesson = await LessonInstance.findOne({ status: "planned", date: { $gte: today } }).sort({ date: 1 }).lean();
  assert.ok(lesson);
  const before = await call(`/teacher/lessons/${lesson._id}/file`, { method: "POST" });
  assert.equal(before.status, 200);
  const changed = await call(`/teacher/lessons/${lesson._id}/file/options`, { method: "PUT", body: { illustrationLevel: "detailed", instruction: "Ajoute un exercice de calcul mental" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.notEqual(changed.body.version, before.body.version);
  assert.equal(changed.body.custom, true);
  assert.equal(changed.body.options.instruction, "Ajoute un exercice de calcul mental");
  assert.equal(await GeneratedDocument.countDocuments({ lessonId: lesson._id, fingerprint: before.body.version }), 0);
  const reset = await call(`/teacher/lessons/${lesson._id}/file/options`, { method: "PUT", body: { reset: true } });
  assert.equal(reset.body.custom, false);
  assert.equal((await call(`/teacher/lessons/0123456789abcdef01234567/file`, { method: "POST" })).status, 404);
});

test("reporter une séance : sa leçon prend le créneau choisi, les suivantes avancent, rien ne se perd", async () => {
  const lessons = await LessonInstance.find({ subjectCode: "MATH", status: "planned", date: { $gt: today } }).sort({ date: 1, start: 1 }).limit(4).lean();
  assert.ok(lessons.length >= 3);
  const [a, b, c] = lessons;
  const out = await call(`/teacher/lessons/${a._id}/postpone`, { method: "POST", body: { to: c.date, today } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.shifted, 2);
  const after = await LessonInstance.find({ _id: { $in: [a._id, b._id, c._id] } }).lean();
  const by = new Map(after.map((l) => [String(l._id), String(l.nodeId)]));
  assert.equal(by.get(String(a._id)), String(b.nodeId));
  assert.equal(by.get(String(b._id)), String(c.nodeId));
  assert.equal(by.get(String(c._id)), String(a.nodeId));
  assert.equal((await call(`/teacher/lessons/${a._id}/postpone`, { method: "POST", body: { to: today, today } })).status, 409);
});
