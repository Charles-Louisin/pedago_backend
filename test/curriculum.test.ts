import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import { parseProgression, similarity } from "../src/services/curriculum.js";
import { localExportsDir } from "../src/services/storage.js";

let mongo: MongoMemoryServer;
let server: Server;
let base = "";
let token = "";

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
  await mongoose.connect(mongo.getUri("pedago-curriculum-test"));
  await seedDatabase();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "enseignant@pedago.test", password: "Pedago-Enseignant-2026!" }),
  }).then((r) => r.json());
  token = login.accessToken;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("lecture d'une progression collée (sections, puces, objectifs)", () => {
  const lessons = parseProgression(`TRIMESTRE 1
Semaine 1 : Les nombres de 0 à 10 : compter ; écrire
- Comparer des nombres jusqu'à 10
2. L'addition sans retenue
Trimestre 2
• La monnaie en FCFA`);
  assert.deepEqual(lessons.map((l) => [l.title, l.term]), [
    ["Les nombres de 0 à 10", 1],
    ["Comparer des nombres jusqu'à 10", 1],
    ["L'addition sans retenue", 1],
    ["La monnaie en FCFA", 2],
  ]);
  assert.deepEqual(lessons[0].objectives, ["compter", "écrire"]);
  assert.equal(lessons[0].week, 1);
});

test("rapprochement de titres proches", () => {
  assert.ok(similarity("La monnaie : les pièces en FCFA", "La monnaie en FCFA") >= 0.45);
  assert.ok(similarity("Les parties d'une plante", "L'addition sans retenue") < 0.2);
});

test("ma progression remplace le programme officiel et la planification la suit", async () => {
  const save = await call("/teacher/curriculum", {
    method: "PUT",
    body: {
      classLevel: "CP",
      subjectCode: "MATH",
      today: "2026-11-22",
      startAt: 1,
      lessons: [
        { title: "Les nombres de 0 à 10" },
        { title: "L'addition sans retenue" },
        { title: "Problèmes au marché du quartier" },
      ],
    },
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.count, 3);
  assert.ok(save.body.matched >= 2);

  const cur = await call("/teacher/curriculum?classLevel=CP&subjectCode=MATH");
  assert.equal(cur.body.source, "mine");
  assert.equal(cur.body.lessons[0].alreadyTaught, true);

  const plan = await call("/teacher/planning?from=2026-11-23&to=2026-11-27");
  const math = plan.body.lessons.filter((l: { subjectCode: string }) => l.subjectCode === "MATH");
  // La 1re leçon est « déjà faite » : on reprend à la 2e, avec les ressources de la leçon officielle rapprochée.
  assert.equal(math[0].node.title, "L'addition sans retenue");
  assert.ok(math[0].resources.length > 0);

  const grid = await call("/teacher/progress/grid?classLevel=CP");
  const g = grid.body.find((s: { subjectCode: string }) => s.subjectCode === "MATH");
  assert.equal(g.source, "mine");
  assert.equal(g.lessons[0].status, "done");
});

test("ma fiche prime sur la bibliothèque dans le PDF généré", async () => {
  const plan = await call("/teacher/planning?from=2026-11-23&to=2026-11-27");
  const lesson = plan.body.lessons.find((l: { subjectCode: string }) => l.subjectCode === "MATH");
  const prep = await call(`/teacher/preps/${lesson.node.id}`, {
    method: "PUT",
    body: { content: { objectives: ["Additionner deux nombres avec des capsules"], writtenTrace: "3 + 2 = 5" } },
  });
  assert.equal(prep.status, 200);
  const doc = await call(`/teacher/lessons/${lesson.id}/document`, { method: "POST", body: { format: "pdf", difficulty: "easy", includeAnswers: false } });
  assert.equal(doc.status, 200);
  assert.equal(doc.body.usedPrep, true);
  assert.equal(doc.body.usedLibrary, true);
  const file = `${localExportsDir}/${doc.body.url.split("/exports/")[1]}`;
  assert.ok(fs.statSync(file).size > 1000);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), "%PDF");
});

test("on ne peut pas attacher une fiche à la leçon personnelle d'un autre enseignant", async () => {
  const other = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: "Intrus Test", email: "intrus@pedago.test", password: "Pedago-Intrus-2026!", passwordConfirm: "Pedago-Intrus-2026!" }),
  }).then((r) => r.json());
  const ver = await fetch(`${base}/api/v1/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${other.accessToken}` },
    body: JSON.stringify({ code: other.devCode }),
  }).then((r) => r.json());
  const cur = await call("/teacher/curriculum?classLevel=CP&subjectCode=MATH");
  const res = await fetch(`${base}/api/v1/teacher/preps/${cur.body.lessons[0].id}`, { headers: { Authorization: `Bearer ${ver.accessToken}` } });
  assert.equal(res.status, 404);
});
