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
import { parsePrepText } from "../src/services/layout.js";
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
  // Un titre court suivi de « : » est un titre complet, pas un titre + objectif.
  assert.deepEqual(parseProgression("4. Lecture : la famille de Mbarga")[0], { title: "Lecture : la famille de Mbarga", objectives: [], term: null, week: null });
});

test("fiche « maison » tapée : rubriques à qualificatif, cartouche avec valeurs, en-tête de tableau ignoré", () => {
  const { content, layout } = parsePrepText(`FICHE DE PRÉPARATION
École : EP Bastos
Classe : CP
Effectif : 62
Date :
Domaine : Mathématiques
Objectif spécifique :
- Additionner deux nombres inférieurs à 10
Matériel didactique : capsules, ardoises
Déroulement
Étapes   Durée   Activités du maître   Activités des élèves
Rappel (5 min) : calcul mental
Découverte (20 min) : manipulation des capsules ; mise en commun
Méthode :
Travail en groupes
Je retiens
Pour additionner, je réunis deux quantités.
Exercices
- 3 + 4 → 7`);
  assert.deepEqual(content.objectives, ["Additionner deux nombres inférieurs à 10"]);
  assert.deepEqual(content.materials, ["capsules", "ardoises"]);
  assert.deepEqual(content.steps?.map((x) => [x.name, x.durationMin]), [["Rappel", 5], ["Découverte", 20]]);
  assert.equal(content.writtenTrace, "Pour additionner, je réunis deux quantités.");
  assert.deepEqual(content.exercises, [{ prompt: "3 + 4", answer: "7" }]);
  assert.deepEqual(content.extra, [{ label: "Méthode", lines: ["Travail en groupes"] }]);
  assert.deepEqual(layout?.header?.map((h) => [h.label, h.field, h.value ?? null]), [
    ["École", "school", "EP Bastos"],
    ["Classe", "class", "CP"],
    ["Effectif", "effectif", "62"],
    ["Date", "date", null],
    ["Domaine", "other", "Mathématiques"],
  ]);
  assert.deepEqual(layout?.sections?.map((x) => x.label), ["Objectif spécifique", "Matériel didactique", "Déroulement", "Méthode", "Je retiens", "Exercices"]);
  assert.equal(layout?.stepColumns?.length, 4);
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
  // Nom de fichier lisible : accents retirés, pas de « re-vision ».
  assert.match(doc.body.url, /-fiche-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-[0-9a-f]{16}\.pdf$/);

  // La fiche apparaît dans « Mes fiches », avec le titre de la leçon.
  const mine = await call("/teacher/preps");
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some((p: { nodeId: string; title: string }) => p.nodeId === lesson.node.id && p.title === lesson.node.title));
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

/** PDF de test contenant du texte (comme une progression ou une fiche tapée à l'ordinateur). */
async function pdfWith(lines: string[]) {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
  for (const l of lines) doc.text(l);
  doc.end();
  return done;
}

async function upload(kind: string, data: Buffer, name: string, type: string) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", new Blob([new Uint8Array(data)], { type }), name);
  const res = await fetch(`${base}/api/v1/teacher/imports`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test("import : progression et fiche en PDF lues sans IA, photo refusée tant que l'IA est inactive", async () => {
  const prog = await upload("curriculum", await pdfWith(["TRIMESTRE 1", "1. Les nombres de 0 à 20", "2. L'addition posée : poser ; calculer", "Trimestre 2", "- La soustraction"]), "progression.pdf", "application/pdf");
  assert.equal(prog.status, 200);
  assert.equal(prog.body.source, "text");
  assert.deepEqual(prog.body.data.lessons.map((l: { title: string; term: number }) => [l.title, l.term]), [
    ["Les nombres de 0 à 20", 1],
    ["L'addition posée", 1],
    ["La soustraction", 2],
  ]);

  const prep = await upload("prep", await pdfWith(["Objectifs :", "- Additionner deux nombres", "Matériel : capsules, ardoises", "Trace écrite", "3 + 2 = 5"]), "ma-fiche.pdf", "application/pdf");
  assert.equal(prep.status, 200);
  assert.deepEqual(prep.body.data.objectives, ["Additionner deux nombres"]);
  assert.deepEqual(prep.body.data.materials, ["capsules", "ardoises"]);
  assert.ok(prep.body.uploadId);

  // La fiche lue s'enregistre avec son fichier d'origine.
  const plan = await call("/teacher/planning?from=2026-11-23&to=2026-11-27");
  const nodeId = plan.body.lessons[0].node.id;
  assert.equal((await call(`/teacher/preps/${nodeId}`, { method: "PUT", body: { content: prep.body.data, uploadId: prep.body.uploadId } })).status, 200);
  const saved = await call(`/teacher/preps/${nodeId}`);
  assert.match(saved.body.fileUrl, /\/exports\/.*fiche-source-/);
  assert.equal(saved.body.fileName, "ma-fiche.pdf");
  // Un identifiant de fichier inconnu (ou d'un autre compte) est refusé.
  assert.equal((await call(`/teacher/preps/${nodeId}`, { method: "PUT", body: { content: {}, uploadId: "0123456789abcdef01234567" } })).status, 404);

  // Photo : demande l'IA (non configurée ici) → message clair, rien n'est enregistré.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d80000000049454e44ae426082", "hex");
  const photo = await upload("prep", png, "photo.png", "image/png");
  assert.equal(photo.status, 503);
  assert.equal(photo.body.code, "AI_NOT_CONFIGURED");
  // Le type réel compte, pas le nom : un texte renommé en .pdf est refusé.
  assert.equal((await upload("curriculum", Buffer.from("pas un pdf"), "faux.pdf", "application/pdf")).status, 415);
});

test("fiche au modèle de l'enseignant : mise en page relevée, aperçu et PDF identiques, niveau signalé", async () => {
  const pdf = await pdfWith([
    "FICHE DE PRÉPARATION",
    "École : EP Bastos",
    "Classe : CP",
    "Effectif : 62",
    "Date :",
    "Objectif spécifique :",
    "- Compter jusqu'à 30",
    "Matériel didactique : bâtonnets, ardoises",
    "Déroulement",
    "Étapes   Durée   Activités du maître   Activités des élèves",
    "Rappel (5 min) : calcul mental",
    "Découverte (20 min) : manipulation des bâtonnets",
    "Je retiens",
    "On compte par dizaines.",
  ]);
  const imp = await upload("prep", pdf, "fiche-maison.pdf", "application/pdf");
  assert.equal(imp.status, 200);
  assert.equal(imp.body.layout.title, "FICHE DE PRÉPARATION");
  assert.deepEqual(imp.body.layout.header.map((h: { label: string }) => h.label), ["École", "Classe", "Effectif", "Date"]);
  assert.deepEqual(imp.body.layout.sections.map((x: { label: string }) => x.label), ["Objectif spécifique", "Matériel didactique", "Déroulement", "Je retiens"]);
  assert.deepEqual(imp.body.layout.stepColumns.map((c: { label: string }) => c.label), ["Étapes", "Durée", "Activités du maître", "Activités des élèves"]);

  const plan = await call("/teacher/planning?from=2026-11-23&to=2026-11-27");
  const lesson = plan.body.lessons.find((l: { subjectCode: string }) => l.subjectCode === "MATH");
  assert.equal((await call(`/teacher/preps/${lesson.node.id}`, { method: "PUT", body: { content: imp.body.data, layout: imp.body.layout, uploadId: imp.body.uploadId } })).status, 200);

  // Aperçu : le modèle de l'enseignant (titre, cartouche, rubriques, colonnes), pas celui de PEDAGO.
  const prev = await call(`/teacher/lessons/${lesson.id}/preview`, { method: "POST", body: { difficulty: "standard", includeAnswers: false } });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.kicker, "FICHE DE PRÉPARATION");
  assert.deepEqual(prev.body.meta.map((m: [string, string]) => m[0]), ["École", "Classe", "Effectif", "Date"]);
  assert.equal(prev.body.meta[1][1], "CP");
  const headings = prev.body.blocks.map((b: { heading: string }) => b.heading);
  assert.deepEqual(headings, ["Objectif spécifique", "Matériel didactique", "Déroulement", "Je retiens"]);
  assert.deepEqual(prev.body.blocks[2].table[0], ["Étapes", "Durée", "Activités du maître", "Activités des élèves"]);
  assert.equal(prev.body.usedLayout, true);
  assert.equal(prev.body.adaptation, "not_needed");

  // Le PDF téléchargé contient exactement les mêmes intitulés, dans le même ordre.
  const doc = await call(`/teacher/lessons/${lesson.id}/document`, { method: "POST", body: { format: "pdf", difficulty: "standard", includeAnswers: false } });
  const { extractText, getDocumentProxy } = await import("unpdf");
  const file = fs.readFileSync(`${localExportsDir}/${doc.body.url.split("/exports/")[1]}`);
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(file)), { mergePages: true });
  // Le titre est espacé lettre à lettre dans le PDF : on compare sans les espaces.
  const squash = (x: string) => x.toUpperCase().replace(/\s+/g, "");
  const flat = squash(String(text));
  let cursor = -1;
  for (const h of ["FICHE DE PRÉPARATION", ...headings.map((h: string) => h.toUpperCase())]) {
    const at = flat.indexOf(squash(h), cursor + 1);
    assert.ok(at > cursor, `« ${h} » absent ou hors d'ordre dans le PDF`);
    cursor = at;
  }

  // Le modèle devient celui des autres fiches de l'enseignant.
  const other = plan.body.lessons.find((l: { subjectCode: string; node: { id: string } }) => l.subjectCode !== "MATH");
  const prevOther = await call(`/teacher/lessons/${other.id}/preview`, { method: "POST", body: {} });
  assert.equal(prevOther.body.kicker, "FICHE DE PRÉPARATION");

  // Niveau facile demandé sans IA : rien n'est inventé, l'aperçu le dit.
  const easy = await call(`/teacher/lessons/${lesson.id}/preview`, { method: "POST", body: { difficulty: "easy" } });
  assert.equal(easy.body.adaptation, "unavailable");
});

test("mes données : export complet puis suppression définitive du compte (fichiers compris)", async () => {
  const exp = await call("/teacher/me/export");
  assert.equal(exp.status, 200);
  assert.equal(exp.body.format, "pedago-export-v1");
  assert.equal(exp.body.account.email, "enseignant@pedago.test");
  assert.equal(exp.body.account.passwordHash, undefined);
  assert.ok(exp.body.preps.length >= 1);
  assert.ok(exp.body.curriculum.length >= 1);
  assert.ok(exp.body.lessons.length >= 1);
  assert.ok(exp.body.documents.length >= 1);
  const files = exp.body.documents.map((d: { url: string }) => `${localExportsDir}/${d.url.split("/exports/")[1]}`);
  assert.ok(files.every((f: string) => fs.existsSync(f)));

  assert.equal((await call("/auth/me", { method: "DELETE", body: { password: "mauvais" } })).status, 400);
  assert.equal((await call("/auth/me", { method: "DELETE", body: { password: "Pedago-Enseignant-2026!" } })).status, 204);

  // Plus de session, plus de connexion, plus de données ni de fichiers.
  assert.equal((await call("/teacher/me")).status, 401);
  const relog = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "enseignant@pedago.test", password: "Pedago-Enseignant-2026!" }),
  });
  assert.equal(relog.status, 401);
  const { LessonInstance, TeacherPrep, CurriculumNode, GeneratedDocument } = await import("../src/models/index.js");
  const userId = exp.body.account._id;
  assert.equal(await LessonInstance.countDocuments({ teacherId: userId }), 0);
  assert.equal(await TeacherPrep.countDocuments({ teacherId: userId }), 0);
  assert.equal(await CurriculumNode.countDocuments({ ownerId: userId }), 0);
  assert.equal(await GeneratedDocument.countDocuments({ teacherId: userId }), 0);
  assert.ok(files.every((f: string) => !fs.existsSync(f)));
});
