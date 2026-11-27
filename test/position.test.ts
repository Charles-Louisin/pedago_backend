import "./helpers/offline-env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import { CurriculumNode, ProgressEvent } from "../src/models/index.js";
import { lessonUnits } from "../src/services/units.js";
import { addDays } from "../src/utils/dates.js";

/** « Où j'en suis » (position dans le programme) et unité de chaque leçon. */
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
  await mongoose.connect(mongo.getUri("pedago-position-test"));
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

test("où j'en suis : ce qui précède compte comme fait, la suite reprend à la leçon choisie, retour possible", async () => {
  const me = (await call("/teacher/me")).body;
  const { classLevel, subjects } = me.profile.assignments[0];
  const subjectCode = subjects[0];
  const q = `classLevel=${classLevel}&subjectCode=${subjectCode}`;
  const before = (await call(`/teacher/curriculum?${q}`)).body;
  assert.ok(before.lessons.length > 6);
  assert.equal(before.position, null);
  const chosen = before.lessons[4];

  const set = await call("/teacher/curriculum/position", { method: "PUT", body: { classLevel, subjectCode, nodeId: chosen.id, today } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.nodeId, chosen.id);

  const after1 = (await call(`/teacher/curriculum?${q}`)).body;
  assert.deepEqual(
    after1.lessons.slice(0, 6).map((l: any) => l.alreadyTaught),
    [true, true, true, true, false, false]
  );
  assert.equal(after1.position.nodeId, chosen.id);
  // Aucun faux bilan.
  assert.equal(await ProgressEvent.countDocuments({}), 0);

  // La prochaine séance de la matière est la leçon choisie (moteur de planification, sans IA).
  const plan = (await call(`/teacher/planning?from=${today}&to=${addDays(today, 20)}&classLevel=${classLevel}`)).body;
  const next = plan.lessons.find((l: any) => l.subjectCode === subjectCode && l.status === "planned");
  assert.ok(next, "une séance prévue");
  assert.equal(next.node.id, chosen.id);

  // Une autre position, puis retour en arrière : on retrouve la précédente, puis plus de position.
  await call("/teacher/curriculum/position", { method: "PUT", body: { classLevel, subjectCode, nodeId: before.lessons[2].id, today } });
  const undo = await call("/teacher/curriculum/position", { method: "PUT", body: { classLevel, subjectCode, nodeId: null, today } });
  assert.equal(undo.body.nodeId, chosen.id);
  const undo2 = await call("/teacher/curriculum/position", { method: "PUT", body: { classLevel, subjectCode, nodeId: null, today } });
  assert.equal(undo2.body.nodeId, null);
  const reset = (await call(`/teacher/curriculum?${q}`)).body;
  assert.ok(reset.lessons.every((l: any) => !l.alreadyTaught));
  const plan2 = (await call(`/teacher/planning?from=${today}&to=${addDays(today, 20)}&classLevel=${classLevel}`)).body;
  assert.equal(plan2.lessons.find((l: any) => l.subjectCode === subjectCode && l.status === "planned")?.node.id, before.lessons[0].id);

  // Leçon étrangère au programme : refusée.
  const bad = await call("/teacher/curriculum/position", { method: "PUT", body: { classLevel, subjectCode, nodeId: new Types.ObjectId().toString(), today } });
  assert.equal(bad.status, 400);
});

test("unité de chaque leçon : intitulé du document, numéro et place dans l'unité", async () => {
  const owner = new Types.ObjectId();
  const common = { ownerId: owner, subsystem: "francophone", classLevel: "CP", subjectCode: "MATH", curriculumVersion: "enseignant", status: "validated" };
  const [u1, u2] = await CurriculumNode.insertMany([
    { ...common, kind: "unit", title: "Les nombres", label: "Séquence 1", order: 1 },
    { ...common, kind: "unit", title: "Les formes", order: 5 },
  ]);
  const lessons = await CurriculumNode.insertMany([
    { ...common, kind: "lesson", title: "Compter", parentId: u1._id, order: 1 },
    { ...common, kind: "lesson", title: "Comparer", parentId: u1._id, order: 2 },
    { ...common, kind: "lesson", title: "Le carré", parentId: u2._id, order: 3 },
  ]);
  const units = await lessonUnits(lessons.map((l) => l._id));
  assert.deepEqual(
    lessons.map((l) => {
      const u = units.get(String(l._id))!;
      return [u.label, u.number, u.lessonIndex, u.lessonCount];
    }),
    [
      ["Séquence 1", 1, 1, 2],
      ["Séquence 1", 1, 2, 2],
      [null, 2, 1, 1],
    ]
  );
});

test("progression lue sans IA : domaine, compétence, séquences et leçons gardent leur hiérarchie", async () => {
  const { parseProgressionTree } = await import("../src/services/curriculum.js");
  const tree = parseProgressionTree(
    [
      "PROGRESSION ANNUELLE DE MATHÉMATIQUES — CE1",
      "Domaine : Numération",
      "Compétence : Dénombrer et comparer des quantités jusqu'à 1 000",
      "Trimestre 1",
      "Séquence 1 : Les nombres jusqu'à 100",
      "Semaine 1 — Leçon 1 : Les nombres de 0 à 100 (lire, écrire). Objectifs : lire les nombres ; écrire les nombres en chiffres et en lettres. Durée : 45 min",
      "Semaine 2 — Leçon 2 : Comparer et ranger les nombres jusqu'à 100. Activité : jeu de la marchande.",
      "Semaine 4 — Évaluation de la séquence 1",
      "Trimestre 2",
      "Séquence 2 : Mesures",
      "Semaine 13 — Leçon 6 : Les centaines",
    ].join("\n")
  );
  assert.deepEqual(
    tree.map((n) => [n.kind, n.label, n.title, n.parent]),
    [
      ["domain", null, "Numération", null],
      ["competency", null, "Dénombrer et comparer des quantités jusqu'à 1 000", 0],
      ["unit", "Séquence 1", "Les nombres jusqu'à 100", 1],
      ["lesson", null, "Les nombres de 0 à 100 (lire, écrire)", 2],
      ["lesson", null, "Comparer et ranger les nombres jusqu'à 100", 2],
      ["lesson", null, "Évaluation de la séquence 1", 2],
      ["unit", "Séquence 2", "Mesures", 1],
      ["lesson", null, "Les centaines", 6],
    ]
  );
  const first = tree[3];
  assert.deepEqual([first.week, first.term, first.durationMin, first.objectives.length], [1, 1, 45, 2]);
  assert.equal(tree[5].isAssessment, true);
  assert.equal(tree[7].term, 2);
});
