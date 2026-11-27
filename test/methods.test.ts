import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import { AiJob, PreparationMethod, SourceDocument } from "../src/models/index.js";
import { methodHandlers } from "../src/ai/method.js";
import { methodBrief, methodFor, pendingMethodsFor, stepGaps, type MethodDoc } from "../src/services/methods.js";
import { WRITE_V1 } from "../src/ai/prompts.js";
import { resourcePreview } from "../src/services/exports.js";
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

let adminToken = "";
async function admin() {
  if (adminToken) return adminToken;
  const first = await call("/auth/login", { method: "POST", body: { identifier: "admin@pedago.test", password: "Pedago-Admin-2026!" } });
  const setup = await call("/auth/mfa/setup", { method: "POST", token: first.body.accessToken });
  const on = await call("/auth/mfa/enable", { method: "POST", token: first.body.accessToken, body: { code: totpAt(setup.body.secret, currentStep()) } });
  adminToken = on.body.accessToken;
  return adminToken;
}

before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-methods-test"));
  await seedDatabase();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

/** Réponse du modèle telle qu'un guide pédagogique la donnerait (aucun appel réseau dans les tests). */
const analysis = {
  methods: [
    {
      title: "Démarche de la leçon de mathématiques",
      classLevels: ["CE1", "CE2"],
      subjectCodes: ["MATH", "XYZ"],
      resourceTypes: ["lesson_plan"],
      header: [
        { label: "École :", field: "school" },
        { label: "Classe", field: "class" },
        { label: "Effectif", field: "effectif" },
      ],
      sections: [
        { key: "competency", label: "Compétence de base", guidance: "Une seule compétence, tirée du curriculum." },
        { key: "objectives", label: "Objectifs spécifiques", guidance: "Commencer par « Être capable de »." },
        { key: "extra", label: "Méthodes et techniques", guidance: "Méthodes actives." },
        { key: "steps", label: "Déroulement de la leçon", guidance: "" },
        { key: "writtenTrace", label: "Résumé", guidance: "" },
      ],
      stepColumns: [
        { key: "name", label: "Étapes" },
        { key: "teacherActivities", label: "Activités de l'enseignant" },
        { key: "learnerActivities", label: "Activités des apprenants" },
      ],
      steps: [
        { name: "Calcul mental", purpose: "Réveil", durationMin: 5, teacherRole: "Pose les calculs", learnerRole: "Répondent sur l'ardoise" },
        { name: "Situation-problème", purpose: "Découverte", durationMin: 15, teacherRole: "", learnerRole: "" },
        { name: "Synthèse", purpose: "Structuration", durationMin: 10, teacherRole: "", learnerRole: "" },
      ],
      conventions: ["Les objectifs commencent par un verbe d'action."],
      pages: [12, 13],
      warnings: [],
    },
  ],
  reason: null,
};

async function savedMethod() {
  const src = await SourceDocument.create({ title: "Guide pédagogique CE", issuer: "MINEDUB", docType: "guide", status: "fetched" });
  const job = await AiJob.create({ kind: "analyze_method", params: { sourceId: String(src._id), subsystem: "francophone" }, steps: [], budgetUsd: 1 });
  const out = await methodHandlers.method_save({ job, outputs: { method_analyze: analysis, method_fetch: { sha256: "abc" } } });
  assert.equal(out.output.created, 1);
  return { src, m: await PreparationMethod.findOne({ sourceId: src._id }).lean() };
}

test("analyse d'un guide : méthode rangée « à valider », intitulés et démarche recopiés, codes inconnus signalés", async () => {
  const { src, m } = await savedMethod();
  assert.ok(m);
  assert.equal(m.status, "extracted");
  assert.deepEqual(m.subjectCodes, ["MATH"]);
  assert.ok(m.warnings.some((w) => /XYZ/.test(w)));
  const layout = m.layout as { header: { label: string }[]; sections: { key: string; label: string }[]; stepColumns: unknown[] };
  assert.equal(layout.header[0].label, "École", "le « : » recopié est retiré du libellé");
  assert.deepEqual(layout.sections.map((s) => s.label), ["Compétence de base", "Objectifs spécifiques", "Méthodes et techniques", "Déroulement de la leçon", "Résumé"]);
  assert.deepEqual(m.extraSections.map((x) => x.label), ["Méthodes et techniques"]);
  assert.deepEqual(m.steps.map((s) => s.name), ["Calcul mental", "Situation-problème", "Synthèse"]);
  assert.equal((await SourceDocument.findById(src._id).lean())?.status, "extracted");
});

test("une méthode non validée n'est jamais suivie, mais bloque la génération qu'elle concerne", async () => {
  await PreparationMethod.deleteMany({});
  await savedMethod();
  const target = { subsystem: "francophone", classLevel: "CE1", subjectCode: "MATH", type: "lesson_plan" };
  assert.equal(await methodFor(target), null);
  assert.equal((await pendingMethodsFor({ ...target, types: ["lesson_plan"] })).length, 1);
  assert.equal((await pendingMethodsFor({ ...target, classLevel: "CM2", types: ["lesson_plan"] })).length, 0, "hors de sa portée : ne bloque pas");
  assert.equal((await pendingMethodsFor({ ...target, types: ["exercises"] })).length, 0, "autre type de ressource : ne bloque pas");
});

test("validation par l'admin : la méthode est suivie, la plus précise l'emporte, la plan l'affiche", async () => {
  await PreparationMethod.deleteMany({});
  const { m } = await savedMethod();
  const token = await admin();
  // Méthode générale validée (toutes classes, toutes matières) : moins précise que celle des maths du CE.
  const general = await PreparationMethod.create({
    sourceId: m!.sourceId,
    title: "Fiche de préparation générale",
    subsystem: "francophone",
    layout: { sections: [{ key: "steps", label: "Déroulement" }] },
    steps: [{ name: "Introduction" }],
    status: "validated",
    validatedAt: new Date(),
  });

  const blocked = await call("/admin/library/plan", { method: "POST", token, body: { subsystem: "francophone", classLevel: "CE1" } });
  assert.equal(blocked.status, 200);
  assert.ok(blocked.body.checks.some((c: { text: string }) => /à valider avant de lancer/.test(c.text)));

  const v = await call(`/admin/methods/${m!._id}/validate`, { method: "POST", token });
  assert.equal(v.status, 200);
  const chosen = await methodFor({ subsystem: "francophone", classLevel: "CE1", subjectCode: "MATH", type: "lesson_plan" });
  assert.equal(chosen?.title, "Démarche de la leçon de mathématiques");
  const other = await methodFor({ subsystem: "francophone", classLevel: "CE1", subjectCode: "FR", type: "lesson_plan" });
  assert.equal(String(other?._id), String(general._id), "les autres matières suivent la méthode générale");

  const plan = await call("/admin/library/plan", { method: "POST", token, body: { subsystem: "francophone", classLevel: "CE1" } });
  const math = plan.body.methods.bySubject.find((x: { subjectCode: string }) => x.subjectCode === "MATH");
  assert.equal(math.method.title, "Démarche de la leçon de mathématiques");
  assert.equal(plan.body.methods.pending.length, 0);

  // Corriger une méthode validée la remet « à valider » (nouvelle version).
  const edit = await call(`/admin/methods/${m!._id}`, { method: "PATCH", token, body: { conventions: ["Verbes d'action mesurables."] } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.status, "extracted");
  assert.equal(edit.body.version, 2);
});

test("rédaction : la méthode validée est imposée au modèle, et les étapes manquantes sont détectées", async () => {
  const m = (await PreparationMethod.findOne({ title: "Démarche de la leçon de mathématiques" }).lean()) as unknown as MethodDoc;
  const brief = methodBrief(m);
  assert.match(brief, /Compétence de base : Une seule compétence/);
  assert.match(brief, /1\. Calcul mental \(≈ 5 min\)/);
  assert.match(brief, /Méthodes et techniques/);
  const prompt = WRITE_V1.user({
    type: "lesson_plan", subsystem: "francophone", classLevel: "CE1", subjectName: "Mathématiques", lessonTitle: "Les nombres",
    objectives: [], durationMin: 45, difficulty: "standard", illustrationLevel: "simple", language: "fr", sourceExcerpts: "", method: brief,
  });
  assert.match(prompt, /Méthode de préparation officielle à suivre STRICTEMENT/);
  assert.match(prompt, /extraSections/);
  const generic = WRITE_V1.user({
    type: "lesson_plan", subsystem: "francophone", classLevel: "CE1", subjectName: "Mathématiques", lessonTitle: "Les nombres",
    objectives: [], durationMin: 45, difficulty: "standard", illustrationLevel: "simple", language: "fr", sourceExcerpts: "",
  });
  assert.doesNotMatch(generic, /STRICTEMENT/);
  assert.deepEqual(stepGaps(m, [{ name: "Calcul mental (5 min)" }, { name: "Synthèse" }]), ["Situation-problème"]);
});

test("PDF : une ressource rédigée selon la méthode reprend ses rubriques, ses intitulés et ses rubriques propres", async () => {
  const m = await PreparationMethod.findOne({ title: "Démarche de la leçon de mathématiques" }).lean();
  const preview = await resourcePreview({
    title: "Les nombres", type: "lesson_plan", classLevel: "CE1", subjectCode: "MATH", difficulty: "standard", contentVersion: 1, sources: [],
    methodLayout: m!.layout,
    content: {
      generalInfo: { durationMin: 30 },
      competency: "Résoudre des problèmes",
      objectives: ["Être capable de compter jusqu'à 100"],
      steps: [{ name: "Calcul mental", durationMin: 5, teacherActivities: ["Pose"], learnerActivities: ["Répondent"] }],
      writtenTrace: "On compte de 10 en 10.",
      extraSections: [{ label: "Méthodes et techniques", lines: ["Travail en groupes"] }],
    },
  });
  const headings = preview.blocks.map((b: { heading?: string }) => b.heading);
  assert.deepEqual(headings.slice(0, 5), ["Compétence de base", "Objectifs spécifiques", "Méthodes et techniques", "Déroulement de la leçon", "Résumé"]);
});
