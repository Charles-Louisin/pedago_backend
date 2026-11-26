import crypto from "node:crypto";
import { Types } from "mongoose";
import { CurriculumNode, GeneratedDocument, LessonInstance, Resource, TeacherPrep, TeacherProfile, Timetable, User } from "../models/index.js";
import { addDays } from "../utils/dates.js";
import { conflict, notFound } from "../utils/http-error.js";
import { logger } from "../utils/logger.js";
import { buildLessonDocument } from "./exports.js";
import type { PrepLayout } from "./layout.js";
import { ensurePlan } from "./planning.js";
import { deleteStoredFile } from "./storage.js";

/**
 * Fiches PRÊTES des séances : pour chaque séance, la fiche (préparation de l'enseignant + bibliothèque, adaptée
 * à son niveau et à ses illustrations) est composée À L'AVANCE côté serveur, une seule fois par contenu.
 * L'app connaît donc la taille exacte avant de télécharger, et chaque carte gère son propre téléchargement.
 *
 * Une fiche est identifiée par une EMPREINTE (contenu de la leçon, fiche de l'enseignant, ressources de la
 * bibliothèque, modèle de mise en page, réglages) : tant qu'elle ne change pas, le même fichier est réutilisé.
 */
const LAYOUT_VERSION = "lesson-file-v1";
/** Préparation automatique : séances des 7 prochains jours seulement (au-delà, à la demande). */
const PREPARE_DAYS = 7;
const CONCURRENCY = 2;

export type Illustration = { url: string; aspect?: number | null; kind?: string; level?: string; color?: boolean; legends?: boolean; description?: string };
export type DocOptions = { difficulty: string; illustrationLevel: string; includeAnswers: boolean; instruction: string | null; illustration: Illustration | null };

type LessonRow = { _id: Types.ObjectId; teacherId: Types.ObjectId; nodeId: Types.ObjectId; classLevel: string; subjectCode: string; date: string; start?: string | null; end?: string | null; status: string; docOptions?: Partial<DocOptions> | null };

async function contextOf(teacherId: string) {
  const [profile, user] = await Promise.all([TeacherProfile.findOne({ userId: teacherId }).lean(), User.findById(teacherId).select("fullName").lean()]);
  if (!profile) throw notFound("Profil introuvable");
  const prefs = (profile.preferences ?? {}) as { difficulty?: string; illustrationLevel?: string; lowInkExports?: boolean };
  const lowInk = prefs.lowInkExports ?? true;
  return {
    lowInk,
    teacherName: user?.fullName ?? "",
    schoolName: profile.schoolName ?? "",
    layout: (profile.prepLayout as PrepLayout | null) ?? null,
    layoutHash: crypto.createHash("sha256").update(JSON.stringify(profile.prepLayout ?? null) + (profile.schoolName ?? "") + (user?.fullName ?? "") + (lowInk ? "|eco" : "")).digest("hex").slice(0, 16),
    defaults: { difficulty: prefs.difficulty ?? "standard", illustrationLevel: prefs.illustrationLevel ?? "simple", includeAnswers: true, instruction: null, illustration: null } as DocOptions,
  };
}

export function optionsOf(lesson: Pick<LessonRow, "docOptions">, defaults: DocOptions): DocOptions {
  const o = lesson.docOptions ?? {};
  return {
    difficulty: o.difficulty ?? defaults.difficulty,
    illustrationLevel: o.illustrationLevel ?? defaults.illustrationLevel,
    includeAnswers: o.includeAnswers ?? defaults.includeAnswers,
    instruction: o.instruction ?? null,
    illustration: o.illustration?.url ? o.illustration : null,
  };
}

/** Empreintes de plusieurs séances en 3 requêtes (leçons, fiches de l'enseignant, ressources de la bibliothèque). */
async function fingerprints(teacherId: string, lessons: LessonRow[], ctx: Awaited<ReturnType<typeof contextOf>>) {
  const nodeIds = [...new Set(lessons.map((l) => String(l.nodeId)))];
  const nodes = await CurriculumNode.find({ _id: { $in: nodeIds } }).select("updatedAt matchedNodeId ownerId").lean();
  const officialIds = nodes.map((n) => (n.ownerId ? n.matchedNodeId : n._id)).filter(Boolean);
  const [preps, resources] = await Promise.all([
    TeacherPrep.find({ teacherId, nodeId: { $in: nodeIds } }).select("nodeId updatedAt").lean(),
    Resource.find({ nodeId: { $in: officialIds }, status: "PUBLISHED", type: { $in: ["lesson_plan", "exercises", "assessment"] } }).select("nodeId contentVersion updatedAt").lean(),
  ]);
  const nodeBy = new Map(nodes.map((n) => [String(n._id), n]));
  const prepBy = new Map(preps.map((p) => [String(p.nodeId), p.updatedAt?.toISOString() ?? ""]));
  const libBy = new Map<string, string[]>();
  for (const r of resources) libBy.set(String(r.nodeId), [...(libBy.get(String(r.nodeId)) ?? []), `${r._id}:${r.contentVersion}:${r.updatedAt?.toISOString()}`]);
  const out = new Map<string, string>();
  for (const l of lessons) {
    const n = nodeBy.get(String(l.nodeId));
    const official = n ? String(n.ownerId ? n.matchedNodeId : n._id) : "";
    const parts = [
      LAYOUT_VERSION,
      String(l.nodeId),
      n?.updatedAt?.toISOString() ?? "",
      prepBy.get(String(l.nodeId)) ?? "",
      (libBy.get(official) ?? []).sort().join(","),
      ctx.layoutHash,
      l.date,
      l.start ?? "",
      JSON.stringify(optionsOf(l, ctx.defaults)),
    ];
    out.set(String(l._id), crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20));
  }
  return out;
}

/* ───────────── Préparation en arrière-plan (dans ce processus, sans doublon) ───────────── */

const running = new Map<string, Promise<unknown>>();
const queue: (() => Promise<void>)[] = [];
let active = 0;
function pump() {
  while (active < CONCURRENCY && queue.length) {
    const task = queue.shift()!;
    active++;
    void task().finally(() => {
      active--;
      pump();
    });
  }
}

async function generate(teacherId: string, lesson: LessonRow, fingerprint: string, ctx: Awaited<ReturnType<typeof contextOf>>) {
  const key = `${lesson._id}|${fingerprint}`;
  const existing = running.get(key);
  if (existing) return existing as ReturnType<typeof buildLessonDocument>;
  const opts = optionsOf(lesson, ctx.defaults);
  const job = (async () => {
    const out = await buildLessonDocument({
      teacherId,
      teacherName: ctx.teacherName,
      schoolName: ctx.schoolName,
      lesson: lesson as never,
      difficulty: opts.difficulty,
      illustrationLevel: opts.illustrationLevel,
      includeAnswers: opts.includeAnswers,
      instruction: opts.instruction,
      illustration: opts.illustration,
      lowInk: ctx.lowInk,
      defaultLayout: ctx.layout,
      format: "pdf",
      fingerprint,
    });
    // L'ancienne version de cette fiche n'est plus servie : son fichier est effacé du stockage.
    const old = await GeneratedDocument.find({ teacherId, lessonId: lesson._id, format: "pdf", fingerprint: { $nin: [null, fingerprint] } }).select("url key").lean();
    await Promise.all(old.map((d) => deleteStoredFile(d.key, d.url)));
    if (old.length) await GeneratedDocument.deleteMany({ _id: { $in: old.map((d) => d._id) } });
    return out;
  })().finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

function enqueue(teacherId: string, lesson: LessonRow, fingerprint: string, ctx: Awaited<ReturnType<typeof contextOf>>) {
  const key = `${lesson._id}|${fingerprint}`;
  if (running.has(key)) return;
  running.set(key, Promise.resolve());
  queue.push(async () => {
    running.delete(key);
    await generate(teacherId, lesson, fingerprint, ctx).catch((err) => logger.warn({ err: (err as Error).message, lessonId: String(lesson._id) }, "Fiche non préparée"));
  });
  pump();
}

export type LessonFile = {
  lessonId: string;
  status: "ready" | "preparing";
  version: string;
  sizeBytes: number | null;
  url: string | null;
  adaptation: string | null;
  options: DocOptions;
  custom: boolean;
};

/**
 * État des fiches d'une plage de séances. Les fiches absentes des 7 prochains jours sont lancées
 * en arrière-plan ; l'app redemande l'état quelques secondes plus tard.
 */
export async function lessonFiles(teacherId: string, from: string, to: string, today: string): Promise<LessonFile[]> {
  const ctx = await contextOf(teacherId);
  const lessons = (await LessonInstance.find({ teacherId, date: { $gte: from, $lte: to }, status: { $nin: ["cancelled", "rescheduled"] } })
    .select("teacherId nodeId classLevel subjectCode date start end status docOptions")
    .lean()) as unknown as LessonRow[];
  if (!lessons.length) return [];
  const prints = await fingerprints(teacherId, lessons, ctx);
  const docs = await GeneratedDocument.find({ teacherId, lessonId: { $in: lessons.map((l) => l._id) }, format: "pdf", fingerprint: { $in: [...prints.values()] } })
    .select("lessonId fingerprint url sizeBytes adaptation")
    .lean();
  const docBy = new Map(docs.map((d) => [`${d.lessonId}|${d.fingerprint}`, d]));
  const horizon = addDays(today, PREPARE_DAYS);
  return lessons.map((l) => {
    const fp = prints.get(String(l._id))!;
    const doc = docBy.get(`${l._id}|${fp}`);
    if (!doc && l.date >= today && l.date <= horizon) enqueue(teacherId, l, fp, ctx);
    return {
      lessonId: String(l._id),
      status: doc ? "ready" : "preparing",
      version: fp,
      sizeBytes: doc?.sizeBytes ?? null,
      url: doc?.url ?? null,
      adaptation: doc?.adaptation ?? null,
      options: optionsOf(l, ctx.defaults),
      custom: Boolean(l.docOptions && Object.keys(l.docOptions).length),
    };
  });
}

async function ownLesson(teacherId: string, lessonId: string) {
  if (!Types.ObjectId.isValid(lessonId)) throw notFound("Séance introuvable");
  const lesson = (await LessonInstance.findOne({ _id: lessonId, teacherId }).lean()) as unknown as LessonRow | null;
  if (!lesson) throw notFound("Séance introuvable");
  return lesson;
}

/** Fiche d'une séance, composée tout de suite si elle n'est pas encore prête (téléchargement demandé). */
export async function lessonFile(teacherId: string, lessonId: string): Promise<LessonFile> {
  const lesson = await ownLesson(teacherId, lessonId);
  const ctx = await contextOf(teacherId);
  const fp = (await fingerprints(teacherId, [lesson], ctx)).get(String(lesson._id))!;
  let doc: { url: string; sizeBytes?: number | null; adaptation?: string | null } | null = await GeneratedDocument.findOne({ teacherId, lessonId: lesson._id, format: "pdf", fingerprint: fp }).select("url sizeBytes adaptation").lean();
  if (!doc) {
    const out = await generate(teacherId, lesson, fp, ctx);
    doc = { url: out.url, sizeBytes: out.sizeBytes, adaptation: out.adaptation };
  }
  return { lessonId, status: "ready", version: fp, sizeBytes: doc!.sizeBytes ?? null, url: doc!.url, adaptation: doc!.adaptation ?? null, options: optionsOf(lesson, ctx.defaults), custom: Boolean(lesson.docOptions) };
}

/**
 * Modification de la fiche d'une séance avec l'IA : niveau, illustrations, corrigés et une demande libre.
 * La fiche est recomposée tout de suite (nouvelle version) ; la fiche partagée de la bibliothèque ne change pas.
 */
export async function customizeLessonFile(teacherId: string, lessonId: string, opts: Partial<DocOptions> & { reset?: boolean }) {
  const lesson = await ownLesson(teacherId, lessonId);
  if (["done", "partial", "missed"].includes(lesson.status)) throw conflict("LESSON_PAST", "Cette séance est déjà faite : sa fiche ne se modifie plus");
  const docOptions = opts.reset
    ? undefined
    : {
        difficulty: opts.difficulty ?? lesson.docOptions?.difficulty,
        illustrationLevel: opts.illustrationLevel ?? lesson.docOptions?.illustrationLevel,
        includeAnswers: opts.includeAnswers ?? lesson.docOptions?.includeAnswers,
        instruction: opts.instruction === undefined ? lesson.docOptions?.instruction ?? null : opts.instruction?.trim().slice(0, 400) || null,
        illustration: lesson.docOptions?.illustration ?? undefined,
      };
  await LessonInstance.updateOne({ _id: lesson._id }, docOptions ? { docOptions } : { $unset: { docOptions: 1 } });
  return lessonFile(teacherId, lessonId);
}

/**
 * Reporter une séance : sa leçon prend le premier créneau de la même matière à partir de la date choisie ;
 * les leçons placées entre-temps avancent d'un créneau. Rien n'est perdu, l'ordre de la progression est gardé.
 */
async function replaceMissed(teacherId: string, lesson: LessonRow, toDate: string, today: string) {
  const { CatchUpItem } = await import("../models/index.js");
  const { applyCatchUp } = await import("./planning.js");
  const item = await CatchUpItem.findOne({ teacherId, lessonId: lesson._id, status: "open" }).lean();
  if (!item) throw conflict("ALREADY_REPLACED", "Cette leçon est déjà replacée dans ton programme");
  const from = toDate > today ? toDate : addDays(today, 1);
  const profile = await TeacherProfile.findOne({ userId: teacherId }).select("schoolYear").lean();
  if (!profile) throw notFound("Profil introuvable");
  await ensurePlan(teacherId, lesson.classLevel, profile.schoolYear, today, addDays(from, 21));
  const target = await LessonInstance.findOne({ teacherId, classLevel: lesson.classLevel, subjectCode: lesson.subjectCode, status: "planned", date: { $gte: from } })
    .sort({ date: 1, start: 1 })
    .lean();
  if (!target) throw conflict("NO_SLOT", "Aucun créneau de cette matière à cette date ou après dans ton emploi du temps");
  const out = await applyCatchUp(teacherId, String(item._id), "insert_next_slot", String(target._id));
  if (!out) throw conflict("NO_SLOT", "Report impossible pour le moment");
  return { lessonId: String(target._id), date: target.date, start: target.start ?? null, shifted: 0 };
}

export async function postponeLesson(teacherId: string, lessonId: string, toDate: string, today: string) {
  const lesson = await ownLesson(teacherId, lessonId);
  // Séance « pas faite » (ou partielle) : elle est replacée au premier cours de la matière à partir de la date
  // choisie, et la suite glisse d'un créneau (même moteur que le rattrapage, rien ne se perd).
  if (lesson.status === "missed" || lesson.status === "partial") return replaceMissed(teacherId, lesson, toDate, today);
  if (lesson.status !== "planned") throw conflict("LESSON_NOT_PLANNED", "Seule une séance prévue peut être reportée");
  if (toDate <= lesson.date || toDate <= today) throw conflict("BAD_DATE", "Choisis une date après celle de la séance");
  const profile = await TeacherProfile.findOne({ userId: teacherId }).select("schoolYear").lean();
  if (!profile) throw notFound("Profil introuvable");
  // Le créneau d'arrivée doit exister : le programme est étendu jusque-là si besoin (sans IA).
  await ensurePlan(teacherId, lesson.classLevel, profile.schoolYear, today, addDays(toDate, 21));
  const chain = await LessonInstance.find({
    teacherId,
    classLevel: lesson.classLevel,
    subjectCode: lesson.subjectCode,
    status: "planned",
    $or: [{ date: { $gt: lesson.date } }, { date: lesson.date, start: { $gte: lesson.start ?? "" } }],
  }).sort({ date: 1, start: 1 });
  const k = chain.findIndex((l) => l.date >= toDate);
  if (k <= 0) throw conflict("NO_SLOT", "Aucun créneau de cette matière à cette date ou après dans ton emploi du temps");
  const moved = chain.slice(0, k + 1);
  // Rotation : chaque séance prend la leçon de la suivante ; la dernière reçoit la leçon reportée.
  const payload = moved.map((l) => ({ nodeId: l.nodeId, origin: l.origin, catchUpOf: l.catchUpOf, remainingObjectives: l.remainingObjectives ?? [], docOptions: l.docOptions }));
  const rotated = [...payload.slice(1), payload[0]];
  for (let i = 0; i < moved.length; i++) {
    const l = moved[i];
    const p = rotated[i];
    l.nodeId = p.nodeId;
    l.origin = p.origin;
    l.catchUpOf = p.catchUpOf;
    l.remainingObjectives = p.remainingObjectives;
    l.set("docOptions", p.docOptions ?? undefined);
    l.rev += 1;
    await l.save();
  }
  await Timetable.updateMany({ teacherId, classLevel: lesson.classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
  const target = moved[moved.length - 1];
  return { lessonId: String(target._id), date: target.date, start: target.start ?? null, shifted: moved.length - 1 };
}

/* ───────────── Illustration de la fiche d'une séance (brouillons à valider) ───────────── */

const ILLUS_KIND: Record<string, string> = {
  schema: "un schéma pédagogique clair, à plat, traits nets",
  color: "une illustration 2D en couleurs, style manuel scolaire",
  bw: "un dessin au trait noir et blanc, facile à photocopier",
  photo: "une image d'aspect photographique réaliste",
  map: "une carte simplifiée",
};
const ILLUS_LEVEL: Record<string, string> = {
  simple: "peu de détails, formes simples et lisibles de loin",
  standard: "détails utiles à la compréhension",
  legend: "finition soignée, détails précis",
};
const MAX_DRAFTS = 4;

export type IllustrationDraft = Illustration & { id: string; createdAt: string };
export type IllustrationRequest = { kind: keyof typeof ILLUS_KIND; level: keyof typeof ILLUS_LEVEL; color: boolean; legends: boolean; description: string; fromDraftId?: string };

type LessonWithDrafts = LessonRow & { illustrationDrafts?: IllustrationDraft[] | null };

/** Ce que l'IA lit de la leçon : titre, objectifs et déroulement de la fiche (jamais de donnée d'élève). */
async function lessonBrief(lesson: LessonRow) {
  const [node, plan] = await Promise.all([
    CurriculumNode.findById(lesson.nodeId).select("title objectives description").lean(),
    Resource.findOne({ nodeId: lesson.nodeId, type: "lesson_plan", status: "PUBLISHED" }).select("content illustrations").lean(),
  ]);
  const c = (plan?.content ?? {}) as { objectives?: string[]; steps?: { name: string; teacherActivities?: string[]; learnerActivities?: string[] }[]; writtenTrace?: string };
  const steps = (c.steps ?? [])
    .map((s) => `${s.name} : ${[...(s.teacherActivities ?? []), ...(s.learnerActivities ?? [])].join(" ; ")}`)
    .join("\n")
    .slice(0, 1400);
  return {
    title: node?.title ?? "",
    objectives: (c.objectives?.length ? c.objectives : (node?.objectives ?? [])).slice(0, 6),
    steps,
    trace: (c.writtenTrace ?? "").slice(0, 400),
    originalUrl: (plan?.illustrations ?? [])[0]?.url ?? null,
  };
}

const toDataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString("base64")}`;
function sniffMime(b: Buffer) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Illustration en place et brouillons en attente de validation. */
export async function lessonIllustration(teacherId: string, lessonId: string) {
  const lesson = (await ownLesson(teacherId, lessonId)) as LessonWithDrafts;
  return { current: lesson.docOptions?.illustration?.url ? lesson.docOptions.illustration : null, drafts: lesson.illustrationDrafts ?? [] };
}

/**
 * Crée un BROUILLON d'illustration pour la fiche d'une séance. L'IA lit la leçon (titre, objectifs, déroulement)
 * et l'illustration actuelle (ou le brouillon qu'on retouche), et ne produit QUE l'image : le reste de la fiche
 * ne change pas. Rien n'entre dans la fiche avant que l'enseignant ne valide un brouillon.
 */
export async function createLessonIllustration(teacherId: string, lessonId: string, o: IllustrationRequest) {
  const lesson = (await ownLesson(teacherId, lessonId)) as LessonWithDrafts;
  if (["done", "partial", "missed"].includes(lesson.status)) throw conflict("LESSON_PAST", "Cette séance est déjà faite : sa fiche ne se modifie plus");
  const drafts = lesson.illustrationDrafts ?? [];
  const base = o.fromDraftId ? drafts.find((d) => d.id === o.fromDraftId) : null;
  if (o.fromDraftId && !base) throw notFound("Brouillon introuvable");
  const brief = await lessonBrief(lesson);
  const { AiJob, TeacherUpload } = await import("../models/index.js");
  const { generateImage } = await import("../ai/openrouter.js");
  const { env } = await import("../config/env.js");
  const { readStoredFile, storeFile } = await import("./storage.js");
  const { imageSize } = await import("./fiche-look.js");

  // Image de départ : le brouillon retouché, sinon l'illustration actuelle de la fiche, sinon celle d'origine.
  const startUrl = base?.url ?? lesson.docOptions?.illustration?.url ?? brief.originalUrl;
  const startData = startUrl ? await readStoredFile(startUrl, 6 * 1024 * 1024) : null;
  const startMime = startData ? sniffMime(startData) : null;
  const previous = base?.description ?? lesson.docOptions?.illustration?.description ?? null;

  const job = await AiJob.create({
    kind: "teacher_illustration",
    status: "running",
    params: { lessonId, kind: o.kind, level: o.level, fromDraft: !!base },
    steps: [{ name: "generate", status: "running", startedAt: new Date() }],
    budgetUsd: 0.15,
    createdBy: teacherId,
    lockedBy: "api-illustration",
    lockedUntil: new Date(Date.now() + 10 * 60_000),
  });
  const clean = (s: string) => s.replace(/[<>]/g, "");
  const prompt = [
    `Tu crées l'illustration de la fiche de préparation d'une leçon d'école primaire au Cameroun (classe ${lesson.classLevel}).`,
    `Leçon : « ${clean(brief.title)} ».`,
    brief.objectives.length ? `Objectifs : ${clean(brief.objectives.join(" ; "))}.` : "",
    brief.steps ? `Déroulement de la leçon :\n${clean(brief.steps)}` : "",
    brief.trace ? `Trace écrite : ${clean(brief.trace)}` : "",
    startMime ? `L'image jointe est l'illustration actuelle${previous ? ` (« ${clean(previous).slice(0, 300)} »)` : ""} : garde ce qui est juste et applique la demande ci-dessous.` : "",
    `Style : ${ILLUS_KIND[o.kind] ?? ILLUS_KIND.schema} ; ${ILLUS_LEVEL[o.level] ?? ILLUS_LEVEL.standard} ; ${o.color && o.kind !== "bw" ? "en couleurs douces" : "en noir et blanc"}.`,
    `Demande de l'enseignant : ${clean(o.description).slice(0, 600)}`,
    o.legends
      ? "Ajoute au plus 6 légendes courtes en français, avec l'orthographe exacte et les mots de la leçon, en lettres capitales d'imprimerie bien lisibles."
      : "N'écris aucun texte, lettre ni chiffre dans l'image.",
    "Fond blanc, cadrage centré, contexte camerounais réaliste et respectueux. Réponds uniquement par l'image.",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const img = await generateImage({
      jobId: String(job._id),
      step: "generate",
      model: env.aiModelImage,
      promptVersion: "illustration-v2",
      prompt,
      images: startData && startMime ? [toDataUrl(startMime, startData)] : [],
    });
    const ext = img.mime === "image/jpeg" ? "jpg" : img.mime === "image/webp" ? "webp" : "png";
    const stored = await storeFile(`illustration-${crypto.randomBytes(10).toString("hex")}.${ext}`, img.data, img.mime);
    await TeacherUpload.create({ teacherId, kind: "figure", url: stored.url, key: stored.key, mime: img.mime, sizeBytes: img.data.length, sha256: stored.sha256 });
    const size = imageSize(img.data);
    const draft: IllustrationDraft = {
      id: crypto.randomBytes(6).toString("hex"),
      url: stored.url,
      aspect: size ? Math.round((size.w / size.h) * 1000) / 1000 : 1.33,
      kind: o.kind,
      level: o.level,
      color: o.color,
      legends: o.legends,
      description: o.description.slice(0, 600),
      createdAt: new Date().toISOString(),
    };
    // Les plus récents d'abord ; au-delà de 4, le plus ancien brouillon est oublié.
    await LessonInstance.updateOne({ _id: lesson._id }, { $set: { illustrationDrafts: [draft, ...drafts].slice(0, MAX_DRAFTS) } });
    await AiJob.updateOne({ _id: job._id }, { status: "done", "steps.0.status": "done", "steps.0.finishedAt": new Date(), $unset: { lockedBy: 1, lockedUntil: 1 } });
  } catch (err) {
    await AiJob.updateOne({ _id: job._id }, { status: "failed", "steps.0.status": "failed", lastError: (err as Error).message?.slice(0, 500), $unset: { lockedBy: 1, lockedUntil: 1 } });
    throw err;
  }
  return lessonIllustration(teacherId, lessonId);
}

/** Valide un brouillon : il devient l'illustration de la fiche (seule l'image change), les autres brouillons sont retirés. */
export async function acceptLessonIllustration(teacherId: string, lessonId: string, draftId: string) {
  const lesson = (await ownLesson(teacherId, lessonId)) as LessonWithDrafts;
  const draft = (lesson.illustrationDrafts ?? []).find((d) => d.id === draftId);
  if (!draft) throw notFound("Brouillon introuvable");
  const { id: _id, createdAt: _at, ...illustration } = draft;
  await LessonInstance.updateOne({ _id: lesson._id }, { $set: { "docOptions.illustration": illustration }, $unset: { illustrationDrafts: 1 } });
  return lessonFile(teacherId, lessonId);
}

/** Écarte un brouillon (la fiche ne change pas). */
export async function discardIllustrationDraft(teacherId: string, lessonId: string, draftId: string) {
  const lesson = (await ownLesson(teacherId, lessonId)) as LessonWithDrafts;
  await LessonInstance.updateOne({ _id: lesson._id }, { $set: { illustrationDrafts: (lesson.illustrationDrafts ?? []).filter((d) => d.id !== draftId) } });
  return lessonIllustration(teacherId, lessonId);
}

/** Retire l'illustration personnalisée (la fiche revient à son image d'origine). */
export async function removeLessonIllustration(teacherId: string, lessonId: string) {
  const lesson = await ownLesson(teacherId, lessonId);
  await LessonInstance.updateOne({ _id: lesson._id }, { $unset: { "docOptions.illustration": 1 } });
  return lessonFile(teacherId, lessonId);
}
