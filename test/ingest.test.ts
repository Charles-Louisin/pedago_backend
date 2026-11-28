import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import { CurriculumNode, Resource, SourceDocument, Subject, User } from "../src/models/index.js";
import { chunksOf, codeFor, storeChunkItems } from "../src/ai/ingest.js";
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
let token = "";
async function admin() {
  if (token) return token;
  const first = await call("/auth/login", { method: "POST", body: { identifier: "admin@pedago.test", password: "Pedago-Admin-2026!" } });
  const setup = await call("/auth/mfa/setup", { method: "POST", token: first.body.accessToken });
  const on = await call("/auth/mfa/enable", { method: "POST", token: first.body.accessToken, body: { code: totpAt(setup.body.secret, currentStep()) } });
  token = on.body.accessToken;
  return token;
}

before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-ingest-test"));
  await seedDatabase();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("découpage : morceaux de taille bornée, une page de recouvrement, toutes les pages couvertes", () => {
  const pages = Array.from({ length: 40 }, (_, i) => ({ page: i + 1, text: "x".repeat(5_000) }));
  const chunks = chunksOf(pages);
  assert.ok(chunks.length > 5);
  assert.equal(chunks[0].from, 1);
  assert.equal(chunks.at(-1)!.to, 40);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].from, chunks[i - 1].to, "la dernière page d'un morceau ouvre le suivant");
});

test("codes de matière lisibles et uniques", () => {
  const taken = new Set(["MATH"]);
  assert.equal(codeFor("Sciences et technologie", taken), "SCITEC");
  assert.equal(codeFor("Sciences et technologie", taken), "SCITEC2");
  assert.equal(codeFor("Mathématiques", new Set()), "MATHEM");
});

test("rangement : chemin partagé entre morceaux, doublons fusionnés, plusieurs classes, matière rapprochée", async () => {
  const src = await SourceDocument.create({ title: "Programme niveau I", issuer: "MINEDUB", docType: "curriculum", status: "verified" });
  const idf = { subsystem: "francophone" as const, classes: ["SIL", "CP"], subjects: [{ code: "MATH", name: "Mathématiques" }], version: "2018" };
  const path = [
    { kind: "domain" as const, title: "Numération", label: null },
    { kind: "unit" as const, title: "Les nombres de 0 à 10", label: "Unité 1" },
  ];
  const lesson = (title: string, pages: number[]) => ({ classes: ["SIL", "CP", "CM2"], subject: "mathematiques", path, lesson: { title, objectives: ["Compter jusqu'à 10"], durationMin: null, term: 1, week: null, period: null }, pages });
  // Morceau 1, puis morceau 2 qui revoit la dernière leçon (page de recouvrement) et continue l'unité.
  assert.equal(await storeChunkItems(String(src._id), idf, [lesson("Compter jusqu'à 5", [3]), lesson("Compter jusqu'à 10", [4])]), 4);
  assert.equal(await storeChunkItems(String(src._id), idf, [lesson("Compter jusqu'à 10", [5]), lesson("Comparer deux nombres", [5])]), 2);

  const cp = await CurriculumNode.find({ "sourceRefs.sourceId": src._id, classLevel: "CP" }).lean();
  assert.equal(cp.filter((n) => n.kind === "unit").length, 1, "une seule unité, retrouvée d'un morceau à l'autre");
  assert.equal(cp.filter((n) => n.kind === "domain").length, 1);
  const lessons = cp.filter((n) => n.kind === "lesson").sort((a, b) => a.order - b.order);
  assert.deepEqual(lessons.map((l) => l.title), ["Compter jusqu'à 5", "Compter jusqu'à 10", "Comparer deux nombres"]);
  assert.deepEqual(lessons[1].sourceRefs[0].pages, [4, 5], "pages fusionnées");
  const unit = cp.find((n) => n.kind === "unit")!;
  assert.equal(unit.label, "Unité 1");
  assert.ok(lessons.every((l) => String(l.parentId) === String(unit._id)));
  assert.ok(lessons.every((l) => l.status === "extracted" && l.subjectCode === "MATH"));
  assert.equal(await CurriculumNode.countDocuments({ "sourceRefs.sourceId": src._id, classLevel: "CM2" }), 0, "classe hors document ignorée");
});

test("tableau de bord : vérifier un programme lance son analyse, validation par lot, référentiel filtré par document", async () => {
  const t = await admin();
  const src = await SourceDocument.create({ title: "Programme niveau II", issuer: "MINEDUB", docType: "curriculum", status: "extracted", extractedText: "x".repeat(500) });
  const v = await call(`/admin/sources/${src._id}`, { method: "PATCH", token: t, body: { status: "verified" } });
  assert.equal(v.status, 200);
  assert.ok(v.body.ingestJobId, "analyse lancée (ou clé IA absente signalée)");
  const list = await call("/admin/sources?limit=50", { token: t });
  const row = list.body.items.find((s: { _id: string }) => s._id === String(src._id));
  assert.equal(row.status, "verified", "la source reste visible dans la liste");

  const first = await SourceDocument.findOne({ title: "Programme niveau I" }).lean();
  const nodes = await call(`/admin/nodes?classLevel=CP&sourceId=${first!._id}`, { token: t });
  assert.equal(nodes.body.length, 5, "domaine, unité et 3 leçons du document");
  const batch = await call("/admin/nodes/validate", { method: "POST", token: t, body: { classLevel: "CP", sourceId: String(first!._id) } });
  assert.equal(batch.body.validated, 5);
  assert.equal(await CurriculumNode.countDocuments({ "sourceRefs.sourceId": first!._id, classLevel: "SIL", status: "extracted" }), 5, "les autres classes attendent leur propre validation");

  const plan = await call("/admin/library/plan", { method: "POST", token: t, body: { subsystem: "francophone", classLevel: "CP" } });
  assert.ok(plan.body.documents.some((d: { title: string }) => d.title === "Programme niveau I"), "le document de la classe apparaît dans la bibliothèque");
});

test("base neuve hors tests : aucune donnée fictive (ni matière, ni leçon, ni ressource, ni compte de démo)", async () => {
  await mongoose.connection.dropDatabase();
  await seedDatabase({ demo: false });
  assert.equal(await Subject.countDocuments(), 0);
  assert.equal(await CurriculumNode.countDocuments(), 0);
  assert.equal(await Resource.countDocuments(), 0);
  assert.equal(await User.countDocuments({ role: "teacher" }), 0, "aucun enseignant fictif");
  assert.ok((await User.countDocuments({ role: "admin" })) <= 1, "au plus le premier administrateur, tiré de SEED_ADMIN_*");
});

test("consolidation : unités et leçons en double fusionnées, casse réparée, ordre des pages", async () => {
  const { consolidateSource, cleanTitle } = await import("../src/ai/ingest.js");
  assert.equal(cleanTitle("UNIté d’APPRENtIssAgE 1. CENtRE d’INtéRêt — LA MAISON"), "Unité d’apprentissage 1. centre d’intérêt — LA MAISON");
  assert.equal(cleanTitle("Les nombres de 0 à 10"), "Les nombres de 0 à 10");
  const src = await SourceDocument.create({ title: "Programme doublons", issuer: "MINEDUB", docType: "curriculum", status: "verified" });
  const idf = { subsystem: "francophone" as const, classes: ["CE1"], subjects: [{ code: "MATH", name: "Mathématiques" }], version: "2018" };
  const item = (unit: string, title: string, pages: number[], competency?: string) => ({
    classes: ["CE1"], subject: "Mathématiques",
    path: [...(competency ? [{ kind: "competency" as const, title: competency, label: null }] : []), { kind: "unit" as const, title: unit, label: null }],
    lesson: { title, objectives: [`Objectif ${title} ${pages[0]}`], durationMin: null, term: null, week: null, period: null }, pages,
  });
  // Même unité écrite de deux façons, avec et sans compétence au-dessus : deux unités et des leçons en double.
  await storeChunkItems(String(src._id), idf, [item("UNIté 1 — LA MAISON", "Les ensembles", [10], "Résoudre des problèmes"), item("UNIté 1 — LA MAISON", "Calcul mental", [11], "Résoudre des problèmes")]);
  await storeChunkItems(String(src._id), idf, [item("Unité 1 — la maison", "Les ensembles", [12]), item("Unité 1 — la maison", "Les nombres de 100 à 200", [9])]);
  assert.equal(await CurriculumNode.countDocuments({ "sourceRefs.sourceId": src._id, kind: "unit" }), 2);

  const out = await consolidateSource(String(src._id));
  assert.ok(out.merged >= 2);
  const units = await CurriculumNode.find({ "sourceRefs.sourceId": src._id, kind: "unit" }).lean();
  assert.equal(units.length, 1, "une seule unité");
  assert.equal(units[0].title, "Unité 1 — LA MAISON");
  assert.ok(units[0].parentId, "l'unité garde sa compétence");
  const lessons = await CurriculumNode.find({ "sourceRefs.sourceId": src._id, kind: "lesson" }).sort({ order: 1 }).lean();
  assert.deepEqual(lessons.map((l) => l.title), ["Les nombres de 100 à 200", "Les ensembles", "Calcul mental"], "dans l'ordre des pages");
  assert.ok(lessons.every((l) => String(l.parentId) === String(units[0]._id)), "toutes rattachées à l'unité gardée");
  const ens = lessons.find((l) => l.title === "Les ensembles")!;
  assert.deepEqual(ens.sourceRefs[0].pages, [10, 12]);
  assert.equal(ens.objectives.length, 2, "objectifs réunis");
});
