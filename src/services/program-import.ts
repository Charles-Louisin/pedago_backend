import crypto from "node:crypto";
import { Types } from "mongoose";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { env } from "../config/env.js";
import { AiJob, IMPORT_CATEGORIES, Subject, TeacherImport, TeacherProfile, TeacherUpload, subsystemOf, type ClassLevel } from "../models/index.js";
import { AiNotConfiguredError, BudgetExceededError, chat, parseJson, type ChatMessage } from "../ai/openrouter.js";
import { IMPORT_CLASSIFY_V1, IMPORT_CURRICULUM_V1, IMPORT_TIMETABLE_V1 } from "../ai/prompts.js";
import { HttpError, badRequest, conflict, notFound } from "../utils/http-error.js";
import { parseProgression, saveImportedCurriculum } from "./curriculum.js";
import { sniffMime } from "./imports.js";
import { docxText, OfficeReadError, xlsxText, zipEntryNames } from "./office-text.js";
import { saveTimetableVersion } from "./planning.js";
import {
  analyzeDraft,
  editableDraftSchema,
  editablePart,
  loadDraftContext,
  matchSubject,
  normalizeTime,
  proposeTimetable,
  type DraftEntry,
  type DraftNode,
  type DraftSubject,
  type EditableDraft,
} from "./program-draft.js";
import { deleteStoredFile, readStoredFile, storeFile } from "./storage.js";

/**
 * Import « Mon programme » : plusieurs fichiers (photos, PDF, Word, Excel), traités EN ARRIÈRE-PLAN par la file
 * `AiJob` existante (verrous, reprises à l'étape échouée, budget par tâche) :
 *   prepare → classify → extract_timetable → extract_curriculum → build
 * Rien n'est enregistré dans le programme avant la validation explicite de l'enseignant.
 *
 * BullMQ / Redis ne sont pas nécessaires : la file Mongo gère déjà la concurrence entre workers, les reprises
 * et l'avancement ; un import fait au plus quelques appels de modèle.
 */
export const PROGRAM_IMPORT_STEPS = ["prepare", "classify", "extract_timetable", "extract_curriculum", "build"] as const;
const STEP_LABELS: Record<(typeof PROGRAM_IMPORT_STEPS)[number], string> = {
  prepare: "Ouverture des documents",
  classify: "Reconnaissance des documents",
  extract_timetable: "Lecture de l'emploi du temps",
  extract_curriculum: "Lecture du curriculum",
  build: "Rapprochement avec le programme national",
};
export const PROGRAM_IMPORT_MAX_FILES = 8;
export const PROGRAM_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** Au-delà, un import encore en cours est considéré comme bloqué (jamais de chargement infini côté app). */
const STALE_MS = 12 * 60_000;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type ImportMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | typeof DOCX | typeof XLSX;
const EXT: Record<ImportMime, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", [DOCX]: "docx", [XLSX]: "xlsx" };

/** Type réel lu sur les premiers octets (jamais d'après le nom ou l'en-tête envoyé). */
export function sniffImportFile(buf: Buffer): ImportMime {
  const basic = sniffMime(buf);
  if (basic) return basic;
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const names = zipEntryNames(buf);
    if (names.includes("word/document.xml")) return DOCX;
    if (names.includes("xl/workbook.xml")) return XLSX;
  }
  if (buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])))
    throw new HttpError(415, "FILE_TYPE_OLD", "Ancien format Word ou Excel (.doc, .xls) : enregistre-le en .docx, .xlsx ou PDF");
  throw new HttpError(415, "FILE_TYPE", "Formats acceptés : photo (JPEG, PNG, WebP), PDF, Word (.docx), Excel (.xlsx)");
}

export type Declared = "timetable" | "curriculum" | "auto";

/* ───────────── Création ───────────── */

export async function createProgramImport(o: { teacherId: string; classLevel: string; schoolYear: string; files: { buffer: Buffer; name: string; declared: Declared }[] }) {
  if (!o.files.length) throw badRequest("FILE_REQUIRED", "Ajoute au moins une photo ou un document");
  if (o.files.length > PROGRAM_IMPORT_MAX_FILES) throw badRequest("TOO_MANY_FILES", `${PROGRAM_IMPORT_MAX_FILES} fichiers au plus par import`);
  const checked = o.files.map((f) => {
    if (f.buffer.length > PROGRAM_IMPORT_MAX_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", `« ${f.name} » est trop lourd (10 Mo maximum)`);
    return { ...f, mime: sniffImportFile(f.buffer) };
  });
  // Fichiers dans le stockage (UploadThing en production) ; la base ne garde que leurs références.
  const files = [];
  for (const f of checked) {
    const stored = await storeFile(`programme-${crypto.randomBytes(10).toString("hex")}.${EXT[f.mime]}`, f.buffer, f.mime);
    const up = await TeacherUpload.create({ teacherId: o.teacherId, kind: "import", url: stored.url, key: stored.key, name: f.name.slice(0, 200), mime: f.mime, sizeBytes: f.buffer.length, sha256: stored.sha256 });
    files.push({ uploadId: up._id, name: f.name.slice(0, 200), mime: f.mime, sizeBytes: f.buffer.length, declared: f.declared });
  }
  const imp = await TeacherImport.create({
    teacherId: o.teacherId,
    classLevel: o.classLevel,
    schoolYear: o.schoolYear,
    status: "queued",
    files,
    progress: { step: "prepare", label: "En attente de lecture", done: 0, total: PROGRAM_IMPORT_STEPS.length },
  });
  const job = await AiJob.create({
    kind: "program_import",
    params: { importId: String(imp._id) },
    steps: PROGRAM_IMPORT_STEPS.map((name) => ({ name })),
    budgetUsd: env.aiImportBudgetUsd,
    createdBy: o.teacherId,
  });
  imp.jobId = job._id;
  await imp.save();
  return { imp, jobId: String(job._id) };
}

/* ───────────── Étapes (exécutées par la file AiJob) ───────────── */

type JobDoc = InstanceType<typeof AiJob>;
type Ctx = { job: JobDoc; outputs: Record<string, any> };
type StepResult = { output?: unknown; skipRest?: boolean; finalStatus?: "done" | "waiting_review" };
type PreparedFile = { index: number; name: string; mime: ImportMime; pages: number; text: string; scanned: boolean; injection: boolean };

async function stepStart(job: JobDoc, step: (typeof PROGRAM_IMPORT_STEPS)[number]) {
  const imp = await TeacherImport.findById(job.params.importId);
  if (!imp) throw new Error("Import introuvable");
  if (imp.status === "cancelled") return null;
  imp.status = "processing";
  imp.progress = { step, label: STEP_LABELS[step], done: PROGRAM_IMPORT_STEPS.indexOf(step), total: PROGRAM_IMPORT_STEPS.length };
  await imp.save();
  return imp;
}
const cancelled: StepResult = { skipRest: true, finalStatus: "done", output: { cancelled: true } };

async function fileBytes(teacherId: unknown, uploadId: unknown) {
  const up = await TeacherUpload.findOne({ _id: uploadId, teacherId }).lean();
  const buf = up ? await readStoredFile(up.url, PROGRAM_IMPORT_MAX_BYTES + 1024) : null;
  if (!buf) throw new Error("Fichier importé introuvable dans le stockage");
  return buf;
}

async function pdfPages(buf: Buffer) {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((t) => String(t ?? ""));
  } catch {
    throw new HttpError(400, "PDF_UNREADABLE", "Un PDF ne peut pas être lu (protégé ou abîmé)");
  }
}

/** Formules typiques d'une tentative de pilotage du modèle par le document. Elles sont ignorées et signalées. */
const INJECTION = /(ignore[sz]?|oublie[sz]?|disregard|forget)\b.{0,40}\b(instructions?|consignes?|r[eè]gles?|rules|previous|pr[ée]c[ée]dentes?)|\b(system prompt|you are now|tu es maintenant|r[ée]ponds? (uniquement|seulement) par)\b/i;

const handlers: Record<string, (ctx: Ctx) => Promise<StepResult>> = {
  async prepare({ job }) {
    const imp = await stepStart(job, "prepare");
    if (!imp) return cancelled;
    const files: PreparedFile[] = [];
    for (const [i, f] of imp.files.entries()) {
      const buf = await fileBytes(imp.teacherId, f.uploadId);
      const mime = f.mime as ImportMime;
      let text = "";
      let pages = 1;
      let scanned = false;
      try {
        if (mime === "application/pdf") {
          const list = await pdfPages(buf);
          pages = list.length;
          text = list.map((t, k) => `[page ${k + 1}]\n${t.trim()}`).join("\n\n");
          // Moins de 60 caractères par page : PDF scanné, lu comme une image par le modèle.
          scanned = list.join("").replace(/\s/g, "").length < 60 * Math.max(1, pages);
        } else if (mime === DOCX) text = docxText(buf);
        else if (mime === XLSX) text = xlsxText(buf);
      } catch (err) {
        if (err instanceof OfficeReadError) throw new HttpError(422, "FILE_UNREADABLE", `« ${f.name} » : ${err.message}`);
        throw err;
      }
      f.pages = pages;
      files.push({ index: i + 1, name: f.name ?? `document ${i + 1}`, mime, pages, text: text.slice(0, 120_000), scanned, injection: INJECTION.test(text) });
    }
    await imp.save();
    return { output: { files } };
  },

  async classify({ job, outputs }) {
    const imp = await stepStart(job, "classify");
    if (!imp) return cancelled;
    const files: PreparedFile[] = outputs.prepare.files;
    let ai: z.infer<typeof classifyOut>["files"] = [];
    if (env.openrouterApiKey) {
      const { text } = await chat({
        jobId: String(job._id),
        step: "classify",
        model: env.aiModelClassify,
        promptVersion: IMPORT_CLASSIFY_V1.version,
        json: true,
        temperature: 0,
        maxTokens: 1500,
        messages: [
          { role: "system", content: IMPORT_CLASSIFY_V1.system },
          { role: "user", content: [{ type: "text", text: `${files.length} document(s) à trier.` }, ...(await materials(imp, files, files.map((f) => f.index), 3000))] },
        ],
      });
      ai = classifyOut.parse(parseJson(text)).files;
    }
    const notes: string[] = [];
    const result = files.map((f) => {
      const declared = (imp.files[f.index - 1].declared ?? "auto") as Declared;
      const guess = heuristicCategory(f.text);
      const a = ai.find((x) => x.file === f.index);
      const decided = decideCategory(declared, a ?? null, guess, f.text.length > 30 && !f.scanned);
      if (decided.note) notes.push(`« ${f.name} » : ${decided.note}`);
      if (f.injection) notes.push(`« ${f.name} » contient des consignes adressées à une IA : elles ont été ignorées.`);
      return { file: f.index, category: decided.category, confidence: decided.confidence, classLevel: a?.classLevel ?? null, note: decided.note ?? a?.note ?? null };
    });
    result.forEach((r) => {
      const target = imp.files[r.file - 1];
      target.category = r.category;
      target.confidence = r.confidence;
      target.classifyNote = r.note?.slice(0, 300) ?? undefined;
    });
    imp.readBy = env.openrouterApiKey ? "ai" : "text";
    await imp.save();
    return { output: { files: result, notes } };
  },

  async extract_timetable({ job, outputs }) {
    const imp = await stepStart(job, "extract_timetable");
    if (!imp) return cancelled;
    const files: PreparedFile[] = outputs.prepare.files;
    const wanted = (outputs.classify.files as { file: number; category: string }[]).filter((c) => c.category === "timetable" || c.category === "both").map((c) => c.file);
    if (!wanted.length) return { output: { entries: [], notes: [], skipped: true } };
    const subsystem = subsystemOf(imp.classLevel as ClassLevel);
    const subjects = await subjectList(subsystem);
    const notes: string[] = [];
    let entries: DraftEntry[] = [];
    if (env.openrouterApiKey) {
      for (const batch of chunk(wanted, 6)) {
        const { text } = await chat({
          jobId: String(job._id),
          step: "extract_timetable",
          model: env.aiModelExtract,
          promptVersion: IMPORT_TIMETABLE_V1.version,
          json: true,
          temperature: 0,
          maxTokens: 10_000,
          messages: [
            { role: "system", content: IMPORT_TIMETABLE_V1.system },
            { role: "user", content: [{ type: "text", text: `Classe déclarée par l'enseignant : ${imp.classLevel} (${subsystem}).\nMatières (code = nom) :\n${subjects.map((s) => `${s.code} = ${s.name}`).join("\n")}` }, ...(await materials(imp, files, batch, 60_000))] },
          ],
        });
        const raw = parseJson<{ entries?: unknown[]; notes?: unknown[] }>(text);
        const read = readTimetableEntries(raw.entries ?? [], subsystem, subjects, entries.length);
        entries = entries.concat(read.entries);
        notes.push(...read.notes, ...stringList(raw.notes));
      }
    } else {
      for (const n of wanted) {
        const f = files[n - 1];
        if (f.scanned || f.text.length < 30) {
          notes.push(`« ${f.name} » : la lecture des photos et des scans demande l'IA, non activée. Saisis ces créneaux à la main.`);
          continue;
        }
        const parsed = parseTimetableText(f.text, subsystem, subjects, n, entries.length);
        entries = entries.concat(parsed);
        if (!parsed.length) notes.push(`« ${f.name} » : aucun créneau horaire reconnu dans le texte.`);
      }
    }
    return { output: { entries, notes } };
  },

  async extract_curriculum({ job, outputs }) {
    const imp = await stepStart(job, "extract_curriculum");
    if (!imp) return cancelled;
    const files: PreparedFile[] = outputs.prepare.files;
    const wanted = (outputs.classify.files as { file: number; category: string }[]).filter((c) => c.category === "curriculum" || c.category === "both").map((c) => c.file);
    if (!wanted.length) return { output: { subjects: [], notes: [], skipped: true } };
    const subsystem = subsystemOf(imp.classLevel as ClassLevel);
    const subjects = await subjectList(subsystem);
    const notes: string[] = [];
    const merged = new Map<string, DraftSubject>();
    const addSubject = (s: { subjectCode: string | null; writtenName: string; classLevelWritten: string | null; nodes: DraftNode[] }) => {
      const key = s.subjectCode ?? `?${normKey(s.writtenName)}`;
      const cur = merged.get(key);
      if (cur) cur.nodes.push(...s.nodes);
      else merged.set(key, { key: `s${merged.size + 1}`, subjectCode: s.subjectCode, writtenName: s.writtenName, classLevelWritten: s.classLevelWritten, startAt: 0, excluded: false, nodes: [...s.nodes] });
    };
    if (env.openrouterApiKey) {
      const parts = curriculumChunks(files, wanted);
      let context: { ref: string; title: string }[] = [];
      for (const [k, part] of parts.entries()) {
        const header = `Classe déclarée par l'enseignant : ${imp.classLevel} (${subsystem}).\nMatières (code = nom) :\n${subjects.map((s) => `${s.code} = ${s.name}`).join("\n")}${
          context.length ? `\nSuite d'un document déjà commencé. Niveaux déjà lus (tu peux les citer en parentRef) :\n${context.slice(-40).map((c) => `${c.ref} = ${c.title}`).join("\n")}` : ""
        }`;
        const content = part.text != null ? [{ type: "text" as const, text: wrapText(part.file, files[part.file - 1].name, part.text) }] : await materials(imp, files, part.files, 0);
        const { text } = await chat({
          jobId: String(job._id),
          step: "extract_curriculum",
          model: env.aiModelExtract,
          promptVersion: IMPORT_CURRICULUM_V1.version,
          json: true,
          temperature: 0,
          maxTokens: 16_000,
          messages: [
            { role: "system", content: IMPORT_CURRICULUM_V1.system },
            { role: "user", content: [{ type: "text", text: header }, ...content] },
          ],
        });
        const raw = parseJson<{ subjects?: unknown[]; notes?: unknown[] }>(text);
        const read = readCurriculumSubjects(raw.subjects ?? [], subjects, `c${k + 1}-`, new Set(context.map((c) => c.ref)));
        for (const s of read.subjects) addSubject(s);
        notes.push(...read.notes, ...stringList(raw.notes));
        context = context.concat(read.subjects.flatMap((s) => s.nodes.filter((n) => n.kind !== "lesson").map((n) => ({ ref: n.ref, title: `${n.label ? `${n.label} : ` : ""}${n.title}` }))));
      }
    } else {
      for (const n of wanted) {
        const f = files[n - 1];
        if (f.scanned || f.text.length < 30) {
          notes.push(`« ${f.name} » : la lecture des photos et des scans demande l'IA, non activée.`);
          continue;
        }
        const lessons = parseProgression(f.text);
        const guess = matchSubject(f.name.replace(/\.\w+$/, ""), subsystem, subjects);
        addSubject({
          subjectCode: guess.code,
          writtenName: f.name.replace(/\.\w+$/, "").slice(0, 160),
          classLevelWritten: null,
          nodes: lessons.map((l, i) => ({ ...emptyNode(`f${n}-l${i + 1}`, "lesson", l.title, n), objectives: l.objectives, term: l.term, week: l.week, confidence: 0.85 })),
        });
      }
    }
    return { output: { subjects: [...merged.values()], notes } };
  },

  async build({ job, outputs }) {
    const imp = await stepStart(job, "build");
    if (!imp) return cancelled;
    const today = new Date().toISOString().slice(0, 10);
    const classifyNotes: string[] = outputs.classify.notes ?? [];
    const ctx = await loadDraftContext(String(imp.teacherId), imp.classLevel, imp.schoolYear, today, classifyNotes);
    const entries: DraftEntry[] = outputs.extract_timetable.entries ?? [];
    const subjects: DraftSubject[] = outputs.extract_curriculum.subjects ?? [];
    const hasTimetable = entries.some((e) => e.kind === "lesson");
    const draft: EditableDraft = editableDraftSchema.parse({
      timetable: { source: hasTimetable ? "document" : subjects.length ? "proposal" : "none", entries },
      curriculum: subjects,
      notes: [...(outputs.extract_timetable.notes ?? []), ...(outputs.extract_curriculum.notes ?? [])].slice(0, 30),
    });
    // Point de départ : d'après les bilans déjà faits (séances réalisées), sinon le début de la liste.
    const first = analyzeDraft(draft, ctx);
    for (const s of draft.curriculum) s.startAt = first.startHints[s.key] ?? 0;
    if (draft.timetable.source === "proposal") draft.timetable.entries = proposeTimetable(draft.curriculum, ctx);
    imp.extraction = {
      classify: outputs.classify.files,
      classifyNotes,
      timetable: outputs.extract_timetable,
      curriculum: outputs.extract_curriculum,
      readBy: imp.readBy,
      promptVersions: [IMPORT_CLASSIFY_V1.version, IMPORT_TIMETABLE_V1.version, IMPORT_CURRICULUM_V1.version],
      extractedAt: new Date(),
    };
    imp.draft = editablePart(draft);
    imp.status = "ready";
    imp.progress = { step: "build", label: "Prêt à vérifier", done: PROGRAM_IMPORT_STEPS.length, total: PROGRAM_IMPORT_STEPS.length };
    imp.markModified("extraction");
    imp.markModified("draft");
    await imp.save();
    // Import prêt : notification (push + cloche) qui ouvre l'écran de vérification.
    const { notify } = await import("./notifications.js");
    await notify(imp.teacherId as never, {
      key: `import:${imp._id}`,
      kind: "import",
      title: "Ton programme est prêt à vérifier",
      body: "L'IA a relu tes documents : vérifie l'emploi du temps et la progression, puis valide.",
      href: `/programme-import/${imp._id}`,
    }).catch(() => undefined);
    return { output: { entries: draft.timetable.entries.length, subjects: draft.curriculum.length }, finalStatus: "done" };
  },
};
export const programImportHandlers = handlers;

/** Appelé par la file quand une tâche d'import échoue définitivement (ou sera retentée). */
export async function programImportSettled(job: JobDoc, err: unknown) {
  if (job.kind !== "program_import") return;
  if (job.status === "queued") {
    await TeacherImport.updateOne({ jobId: job._id, status: { $in: ["queued", "processing"] } }, { "progress.label": "Nouvel essai dans un instant…" });
    return;
  }
  if (job.status !== "failed" && job.status !== "budget_exceeded") return;
  const error =
    err instanceof BudgetExceededError
      ? { code: "AI_BUDGET", message: "La lecture automatique est indisponible pour aujourd'hui. Réessaie demain, ou saisis ton emploi du temps à la main." }
      : err instanceof AiNotConfiguredError
        ? { code: "AI_NOT_CONFIGURED", message: "La lecture des photos et des scans demande l'IA, pas encore activée. Importe un PDF texte, un Word ou un Excel." }
        : err instanceof HttpError
          ? { code: err.code, message: err.message }
          : { code: "IMPORT_FAILED", message: "La lecture de tes documents a échoué. Réessaie, ou recommence avec une photo plus nette." };
  await TeacherImport.updateOne({ jobId: job._id, status: { $in: ["queued", "processing"] } }, { status: "failed", error });
}

/* ───────────── Matériaux envoyés au modèle ───────────── */

const safeName = (s: string) => s.replace(/[<>"\n\r]/g, " ").slice(0, 60);
/** Le texte d'un document ne peut pas fermer la balise qui l'enferme. */
const escapeDoc = (s: string) => s.replace(/<\/?\s*document/gi, "‹document");
function wrapText(file: number, name: string, text: string) {
  return `<document file="${file}" name="${safeName(name)}">\n${escapeDoc(text)}\n</document>`;
}

async function materials(imp: InstanceType<typeof TeacherImport>, files: PreparedFile[], indices: number[], maxChars: number): Promise<Exclude<ChatMessage["content"], string>> {
  const parts: Exclude<ChatMessage["content"], string> = [];
  for (const n of indices) {
    const f = files[n - 1];
    if (!f.scanned && f.text.trim().length > 30) {
      parts.push({ type: "text", text: wrapText(n, f.name, maxChars ? f.text.slice(0, maxChars) : f.text) });
      continue;
    }
    const buf = await fileBytes(imp.teacherId, imp.files[n - 1].uploadId);
    parts.push({ type: "text", text: `<document file="${n}" name="${safeName(f.name)}"> (fichier joint ci-dessous)` });
    if (f.mime === "application/pdf") parts.push({ type: "file", file: { filename: `document-${n}.pdf`, file_data: `data:application/pdf;base64,${buf.toString("base64")}` } });
    else parts.push({ type: "image_url", image_url: { url: `data:${f.mime};base64,${buf.toString("base64")}` } });
  }
  return parts;
}

/** Découpe du curriculum : textes longs par morceaux de 40 000 caractères (aux sauts de page), images par 5. */
function curriculumChunks(files: PreparedFile[], wanted: number[]) {
  const out: { file: number; files: number[]; text: string | null }[] = [];
  let images: number[] = [];
  for (const n of wanted) {
    const f = files[n - 1];
    if (!f.scanned && f.text.trim().length > 30) {
      let rest = f.text;
      while (rest.length) {
        let cut = rest.length <= 40_000 ? rest.length : rest.lastIndexOf("\n[page ", 40_000);
        if (cut <= 10_000) cut = rest.lastIndexOf("\n", 40_000);
        if (cut <= 10_000) cut = Math.min(rest.length, 40_000);
        out.push({ file: n, files: [n], text: rest.slice(0, cut) });
        rest = rest.slice(cut);
      }
    } else if (f.mime === "application/pdf") out.push({ file: n, files: [n], text: null });
    else {
      images.push(n);
      if (images.length === 5) {
        out.push({ file: images[0], files: images, text: null });
        images = [];
      }
    }
  }
  if (images.length) out.push({ file: images[0], files: images, text: null });
  return out.slice(0, 12);
}

const chunk = <T>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const normKey = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const stringList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 400)) : []);

async function subjectList(subsystem: string) {
  return (await Subject.find({ subsystem }).sort({ order: 1 }).select("code name").lean()).map((s) => ({ code: s.code, name: s.name }));
}

/* ───────────── Classement ───────────── */

const classifyOut = z.object({
  files: z
    .array(
      z.object({
        file: z.coerce.number().int(),
        category: z.enum(IMPORT_CATEGORIES).catch("other"),
        confidence: z.coerce.number().min(0).max(1).catch(0.5),
        classLevel: z.string().max(40).nullish().catch(null),
        note: z.string().max(300).nullish().catch(null),
      })
    )
    .max(20),
});

const DAY_RE = /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
const RANGE_RE = /(\d{1,2})\s*[hH:.]\s*(\d{2})?\s*(?:-|–|—|à|a|to)\s*(\d{1,2})\s*[hH:.]\s*(\d{2})?/g;

/** Classement sans IA (et contrôle de l'IA) : jours et plages horaires d'un côté, leçons et séquences de l'autre. */
export function heuristicCategory(text: string): { category: (typeof IMPORT_CATEGORIES)[number]; confidence: number } {
  if (text.trim().length < 30) return { category: "other", confidence: 0 };
  const days = new Set((text.match(DAY_RE) ?? []).map((d) => d.toLowerCase())).size;
  const ranges = (text.match(RANGE_RE) ?? []).length;
  const tt = (days >= 3 ? 2 : 0) + (ranges >= 4 ? 2 : ranges >= 2 ? 1 : 0) + (/emploi du temps|time ?table|horaire/i.test(text) ? 2 : 0);
  const cu =
    (/progression|curriculum|programme|scheme of work|r[ée]partition/i.test(text) ? 2 : 0) +
    (/s[ée]quence|comp[ée]tence|unit[ée]|objectifs?|le[cç]ons?|lessons?|th[eè]me/i.test(text) ? 1 : 0) +
    ((text.match(/\b(trimestre|term|semaine|week)\s*\d/gi) ?? []).length >= 2 ? 2 : 0);
  if (tt >= 3 && cu >= 3) return { category: "both", confidence: 0.6 };
  if (tt >= 3) return { category: "timetable", confidence: Math.min(0.9, 0.5 + tt / 10) };
  if (cu >= 2) return { category: "curriculum", confidence: Math.min(0.9, 0.5 + cu / 10) };
  return { category: "other", confidence: 0.3 };
}

const LABEL: Record<string, string> = { timetable: "Mon emploi du temps", curriculum: "Mon curriculum" };

export function decideCategory(
  declared: Declared,
  ai: { category: (typeof IMPORT_CATEGORIES)[number]; confidence: number } | null,
  guess: { category: (typeof IMPORT_CATEGORIES)[number]; confidence: number },
  hasText: boolean
): { category: (typeof IMPORT_CATEGORIES)[number]; confidence: number; note?: string } {
  const seen = ai && ai.confidence >= 0.6 ? ai : hasText && guess.confidence >= 0.6 ? guess : null;
  const covers = (c: string, d: string) => c === d || c === "both";
  if (!seen || seen.category === "other") {
    if (declared !== "auto") return { category: declared, confidence: seen ? 0.4 : 0.5, note: seen ? "document peu reconnaissable, lu comme tu l'as indiqué." : undefined };
    return seen ? { category: "other", confidence: seen.confidence, note: "document non reconnu (ni emploi du temps, ni curriculum) : ignoré." } : { category: "both", confidence: 0.3, note: "type de document incertain : lu comme emploi du temps et comme curriculum." };
  }
  if (declared !== "auto" && !covers(seen.category, declared))
    return { category: seen.category, confidence: seen.confidence, note: `rangé dans « ${LABEL[declared]} », mais il ressemble plutôt à ${seen.category === "timetable" ? "un emploi du temps" : "un curriculum"} : lu comme tel.` };
  if (seen.category === "both") return { category: "both", confidence: seen.confidence, note: "contient à la fois un emploi du temps et un curriculum." };
  return { category: seen.category, confidence: seen.confidence };
}

/* ───────────── Lecture des réponses du modèle (tolérante, jamais inventive) ───────────── */

const str = (max: number) => z.union([z.string(), z.number()]).transform((v) => String(v).trim().slice(0, max)).nullish().catch(null);
const conf = z.coerce.number().min(0).max(1).catch(0.5).default(0.5);
const entryIn = z.object({
  file: z.coerce.number().int().min(1).max(20).nullish().catch(null),
  weekday: z.coerce.number().int().min(1).max(6).nullish().catch(null),
  start: str(20),
  end: str(20),
  kind: z.enum(["lesson", "break", "special"]).catch("lesson"),
  label: str(120),
  subjectCode: str(40),
  room: str(80),
  confidence: conf,
  doubt: str(300),
});

export function readTimetableEntries(raw: unknown[], subsystem: "francophone" | "anglophone", subjects: { code: string; name: string }[], offset = 0) {
  const entries: DraftEntry[] = [];
  let dropped = 0;
  for (const item of raw.slice(0, 120)) {
    const p = entryIn.safeParse(item);
    if (!p.success || (!p.data.label && !p.data.subjectCode)) {
      dropped++;
      continue;
    }
    const e = p.data;
    const doubts = e.doubt ? [e.doubt] : [];
    let confidence = e.confidence;
    const start = normalizeTime(e.start ?? undefined);
    const end = normalizeTime(e.end ?? undefined);
    if (e.start && !start) doubts.push(`heure de début illisible (« ${e.start} »)`);
    if (e.end && !end) doubts.push(`heure de fin illisible (« ${e.end} »)`);
    const label = e.label || subjects.find((s) => s.code === e.subjectCode)?.name || "";
    let subjectCode: string | null = null;
    if (e.kind === "lesson") {
      const modelCode = e.subjectCode && subjects.some((s) => s.code === e.subjectCode) ? e.subjectCode : null;
      const local = matchSubject(label, subsystem, subjects);
      subjectCode = modelCode ?? local.code;
      if (modelCode && local.code && modelCode !== local.code) {
        doubts.push(`matière à vérifier : « ${label} » peut aussi correspondre à ${subjects.find((s) => s.code === local.code)?.name ?? local.code}`);
        confidence = Math.min(confidence, 0.6);
      }
      if (local.ambiguous && !modelCode) doubts.push("la case cite plusieurs matières");
    }
    entries.push({
      id: `t${offset + entries.length + 1}`,
      weekday: e.weekday ?? null,
      start,
      end,
      kind: e.kind,
      label,
      subjectCode,
      room: e.room ?? null,
      confidence,
      doubt: doubts.length ? doubts.join(" ; ").slice(0, 300) : null,
      confirmed: false,
      edited: false,
      file: e.file ?? null,
    });
  }
  return { entries, notes: dropped ? [`${dropped} case(s) de l'emploi du temps n'ont pas pu être lues : vérifie qu'il ne manque rien.`] : [] };
}

const nodeIn = z.object({
  ref: str(40),
  parentRef: str(40),
  kind: z.enum(["domain", "competency", "unit", "lesson"]).catch("lesson"),
  label: str(80),
  title: str(240),
  objectives: z.array(z.string()).max(40).catch([]).default([]),
  activities: z.array(z.string()).max(40).catch([]).default([]),
  assessments: z.array(z.string()).max(30).catch([]).default([]),
  prerequisites: z.array(z.string()).max(30).catch([]).default([]),
  term: z.coerce.number().int().min(1).max(3).nullish().catch(null),
  period: str(80),
  week: z.coerce.number().int().min(1).max(60).nullish().catch(null),
  durationMin: z.coerce.number().int().min(5).max(600).nullish().catch(null),
  isAssessment: z.coerce.boolean().catch(false).default(false),
  confidence: conf,
  doubt: str(300),
  file: z.coerce.number().int().min(1).max(20).nullish().catch(null),
});
const subjectIn = z.object({ subject: str(160), subjectCode: str(40), classLevel: str(40), nodes: z.array(z.unknown()).max(800).catch([]).default([]) });

const cutList = (l: string[], n: number, max: number) => l.map((x) => x.trim().slice(0, max)).filter(Boolean).slice(0, n);

function emptyNode(ref: string, kind: DraftNode["kind"], title: string, file: number | null): DraftNode {
  return { ref, parentRef: null, kind, label: null, title, objectives: [], activities: [], assessments: [], prerequisites: [], term: null, period: null, week: null, durationMin: null, isAssessment: false, confidence: 1, doubt: null, confirmed: false, edited: false, file };
}

export function readCurriculumSubjects(raw: unknown[], subjects: { code: string; name: string }[], prefix: string, knownRefs = new Set<string>()) {
  const out: { subjectCode: string | null; writtenName: string; classLevelWritten: string | null; nodes: DraftNode[] }[] = [];
  let dropped = 0;
  for (const item of raw.slice(0, 20)) {
    const s = subjectIn.safeParse(item);
    if (!s.success) {
      dropped++;
      continue;
    }
    const nodes: DraftNode[] = [];
    const localRefs = new Map<string, string>();
    for (const [i, rawNode] of s.data.nodes.entries()) {
      const p = nodeIn.safeParse(rawNode);
      if (!p.success || !p.data.title) {
        dropped++;
        continue;
      }
      const n = p.data;
      const ref = `${prefix}${n.ref || `n${i + 1}`}`;
      localRefs.set(n.ref || `n${i + 1}`, ref);
      nodes.push({
        ...emptyNode(ref, n.kind, n.title ?? "", n.file ?? null),
        parentRef: n.parentRef ?? null,
        label: n.label ?? null,
        objectives: cutList(n.objectives, 20, 400),
        activities: cutList(n.activities, 20, 400),
        assessments: cutList(n.assessments, 12, 400),
        prerequisites: cutList(n.prerequisites, 12, 240),
        term: n.term ?? null,
        period: n.period ?? null,
        week: n.week ?? null,
        durationMin: n.durationMin ?? null,
        isAssessment: n.isAssessment,
        confidence: n.confidence,
        doubt: n.doubt ?? null,
      });
    }
    // Parents : référence locale à ce morceau, ou niveau lu dans un morceau précédent (déjà préfixé).
    for (const n of nodes) if (n.parentRef) n.parentRef = localRefs.get(n.parentRef) ?? (knownRefs.has(n.parentRef) ? n.parentRef : null);
    const code = s.data.subjectCode && subjects.some((x) => x.code === s.data.subjectCode) ? s.data.subjectCode : null;
    out.push({ subjectCode: code, writtenName: s.data.subject || subjects.find((x) => x.code === code)?.name || "Matière", classLevelWritten: s.data.classLevel ?? null, nodes });
  }
  return { subjects: out, notes: dropped ? [`${dropped} élément(s) du curriculum n'ont pas pu être lus : vérifie qu'il ne manque rien.`] : [] };
}

/* ───────────── Lecture directe d'un emploi du temps en texte (Word, Excel, PDF texte ; sans IA) ───────────── */

const DAY_INDEX: Record<string, number> = { lundi: 1, monday: 1, mardi: 2, tuesday: 2, mercredi: 3, wednesday: 3, jeudi: 4, thursday: 4, vendredi: 5, friday: 5, samedi: 6, saturday: 6 };
const dayOf = (cell: string) => {
  const m = cell.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/^\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  return m ? DAY_INDEX[m[1]] : null;
};
function rangeOf(cell: string) {
  const m = new RegExp(RANGE_RE.source).exec(cell);
  if (!m) return null;
  const start = normalizeTime(`${m[1]}:${m[2] ?? "00"}`);
  const end = normalizeTime(`${m[3]}:${m[4] ?? "00"}`);
  return start && end ? { start, end } : null;
}
const BREAK_RE = /r[ée]cr[ée]ation|pause|break|repas|d[ée]jeuner|lunch|recess|sieste/i;
const SPECIAL_RE = /c[ée]r[ée]monie|couleurs|assembl[ée]e|salubrit[ée]|nettoyage|p[ée]ri ?scolaire|post ?scolaire|sport de masse|flag/i;
const kindOf = (label: string): DraftEntry["kind"] => (BREAK_RE.test(label) ? "break" : SPECIAL_RE.test(label) ? "special" : "lesson");

/**
 * Grille « | heures | lundi | mardi | … | » (jours en colonnes) ou l'inverse (heures en colonnes),
 * sinon lignes « Lundi 07h30 - 08h30 Calcul ». Les cases vides ne créent rien ; rien n'est deviné.
 */
export function parseTimetableText(text: string, subsystem: "francophone" | "anglophone", subjects: { code: string; name: string }[], file: number, offset = 0): DraftEntry[] {
  const out: Omit<DraftEntry, "id">[] = [];
  const rows = text.split(/\r?\n/).filter((l) => l.trim().startsWith("|")).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  let dayCols: Map<number, number> | null = null;
  let timeCols: Map<number, { start: string; end: string }> | null = null;
  const push = (weekday: number, range: { start: string; end: string }, label: string, confidence: number) => {
    if (!label || /^[-–—.\s]*$/.test(label)) return;
    const kind = kindOf(label);
    const m = kind === "lesson" ? matchSubject(label, subsystem, subjects) : { code: null, ambiguous: false };
    out.push({ weekday, start: range.start, end: range.end, kind, label: label.slice(0, 120), subjectCode: m.code, room: null, confidence, doubt: m.ambiguous ? "la case cite plusieurs matières" : null, confirmed: false, edited: false, file });
  };
  for (const cells of rows) {
    const days = new Map<number, number>();
    cells.forEach((c, i) => {
      const d = dayOf(c);
      if (d) days.set(i, d);
    });
    if (days.size >= 3) {
      dayCols = days;
      timeCols = null;
      continue;
    }
    const times = new Map<number, { start: string; end: string }>();
    cells.forEach((c, i) => {
      const r = rangeOf(c);
      if (r && c.replace(new RegExp(RANGE_RE.source), "").trim().length < 4) times.set(i, r);
    });
    if (times.size >= 3 && !dayCols) {
      timeCols = times;
      continue;
    }
    if (dayCols) {
      const range = cells.map(rangeOf).find(Boolean);
      if (!range) continue;
      for (const [col, wd] of dayCols) push(wd, range, cells[col] ?? "", 0.9);
    } else if (timeCols) {
      const wd = cells.map(dayOf).find(Boolean);
      if (!wd) continue;
      for (const [col, range] of timeCols) push(wd, range, cells[col] ?? "", 0.9);
    }
  }
  if (!out.length) {
    // Lignes libres : « Lundi », puis « 07h30 - 08h30 : Calcul » (ou tout sur une ligne).
    let current: number | null = null;
    for (const line of text.split(/\r?\n/)) {
      const d = dayOf(line);
      if (d) current = d;
      const r = rangeOf(line);
      if (!r || !current) continue;
      const label = line
        .replace(new RegExp(RANGE_RE.source), "")
        .replace(/^\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|monday|tuesday|wednesday|thursday|friday|saturday)\b\s*[:\-–]?/i, "")
        .replace(/^[\s:\-–|]+/, "")
        .trim();
      push(current, r, label, 0.75);
    }
  }
  // Une même grille lue deux fois (deux feuilles identiques) ne crée pas de doublons.
  const seen = new Set<string>();
  return out
    .filter((e) => {
      const k = `${e.weekday}|${e.start}|${e.end}|${e.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 120)
    .map((e, i) => ({ ...e, id: `t${offset + i + 1}` }));
}

/* ───────────── Lecture, correction, validation (routes) ───────────── */

async function ownImport(teacherId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Import introuvable");
  const imp = await TeacherImport.findOne({ _id: id, teacherId });
  if (!imp) throw notFound("Import introuvable");
  return imp;
}

/** Import encore « en cours » mais sans avancée depuis trop longtemps : marqué en échec (l'app propose de réessayer). */
async function healStale(imp: InstanceType<typeof TeacherImport>) {
  if (imp.status !== "queued" && imp.status !== "processing") return;
  const job = imp.jobId ? await AiJob.findById(imp.jobId).select("status updatedAt lastError").lean() : null;
  const last = Math.max(new Date(imp.updatedAt ?? 0).getTime(), new Date(job?.updatedAt ?? 0).getTime());
  if (job && (job.status === "failed" || job.status === "budget_exceeded" || job.status === "cancelled")) {
    imp.status = "failed";
    imp.error = { code: job.status === "budget_exceeded" ? "AI_BUDGET" : "IMPORT_FAILED", message: job.status === "budget_exceeded" ? "La lecture automatique est indisponible pour aujourd'hui. Réessaie demain." : "La lecture de tes documents a échoué. Réessaie." };
    await imp.save();
  } else if (!job || Date.now() - last > STALE_MS) {
    imp.status = "failed";
    imp.error = { code: "IMPORT_TIMEOUT", message: "La lecture a pris trop de temps. Réessaie : les étapes déjà faites ne seront pas refaites." };
    await imp.save();
  }
}

export async function importView(imp: InstanceType<typeof TeacherImport>, today: string) {
  await healStale(imp);
  const base = {
    id: String(imp._id),
    classLevel: imp.classLevel,
    schoolYear: imp.schoolYear,
    status: imp.status,
    readBy: imp.readBy ?? null,
    files: imp.files.map((f, i) => ({ file: i + 1, name: f.name ?? `Document ${i + 1}`, mime: f.mime, pages: f.pages ?? null, declared: f.declared, category: f.category ?? null, confidence: f.confidence ?? null, note: f.classifyNote ?? null })),
    progress: { ...(imp.progress ?? {}), percent: Math.round(((imp.progress?.done ?? 0) / Math.max(1, imp.progress?.total ?? 1)) * 100) },
    error: imp.error?.code ? imp.error : null,
    createdAt: imp.createdAt,
    updatedAt: imp.updatedAt,
    validatedAt: imp.validatedAt ?? null,
    timetableVersion: imp.timetableVersion ?? null,
  };
  if ((imp.status !== "ready" && imp.status !== "validated") || !imp.draft) return { ...base, draft: null };
  const ctx = await loadDraftContext(String(imp.teacherId), imp.classLevel, imp.schoolYear, today, classifyNotesOf(imp));
  return { ...base, draft: analyzeDraft(editableDraftSchema.parse(imp.draft), ctx) };
}

/** Remarques du classement (document rangé ailleurs, consignes ignorées…), gardées avec l'extraction. */
function classifyNotesOf(imp: InstanceType<typeof TeacherImport>): string[] {
  const notes = (imp.extraction as { classifyNotes?: unknown } | null)?.classifyNotes;
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string") : [];
}

export async function getImport(teacherId: string, id: string, today: string) {
  return importView(await ownImport(teacherId, id), today);
}

export async function listImports(teacherId: string) {
  const list = await TeacherImport.find({ teacherId }).sort({ createdAt: -1 }).limit(10).select("classLevel status files.name progress createdAt validatedAt timetableVersion").lean();
  return list.map((i) => ({ id: String(i._id), classLevel: i.classLevel, status: i.status, files: i.files.length, label: i.progress?.label ?? null, createdAt: i.createdAt, validatedAt: i.validatedAt ?? null, timetableVersion: i.timetableVersion ?? null }));
}

export const draftPatchSchema = z.object({
  timetable: editableDraftSchema.shape.timetable.optional(),
  curriculum: editableDraftSchema.shape.curriculum.optional(),
});

/** Corrections de l'enseignant : la partie modifiable est remplacée section par section, puis tout est recalculé. */
export async function patchDraft(teacherId: string, id: string, patch: z.infer<typeof draftPatchSchema>, today: string) {
  const imp = await ownImport(teacherId, id);
  if (imp.status !== "ready" || !imp.draft) throw conflict("IMPORT_NOT_READY", "Cet import n'est pas (ou plus) modifiable");
  const current = editableDraftSchema.parse(imp.draft);
  imp.draft = editablePart(editableDraftSchema.parse({ ...current, ...patch }));
  imp.markModified("draft");
  await imp.save();
  return importView(imp, today);
}

/**
 * Validation : nouvelle version d'emploi du temps (l'ancienne va dans l'historique), progression importée
 * par matière (hiérarchie comprise), matières ajoutées au profil. L'accueil s'en sert ensuite sans IA.
 */
export async function validateImport(teacherId: string, id: string, today: string) {
  const imp = await ownImport(teacherId, id);
  if (imp.status === "validated") throw conflict("IMPORT_VALIDATED", "Ce programme est déjà validé");
  if (imp.status !== "ready" || !imp.draft) throw conflict("IMPORT_NOT_READY", "La lecture n'est pas terminée");
  const profile = await TeacherProfile.findOne({ userId: teacherId });
  if (!profile) throw badRequest("PROFILE_REQUIRED", "Complète d'abord ton profil pédagogique");
  if (profile.schoolYear !== imp.schoolYear) throw conflict("SCHOOL_YEAR_CHANGED", "L'année scolaire de ton profil a changé : recommence l'import");
  const ctx = await loadDraftContext(teacherId, imp.classLevel, imp.schoolYear, today, classifyNotesOf(imp));
  const draft = analyzeDraft(editableDraftSchema.parse(imp.draft), ctx);
  const blocking = draft.issues.filter((i) => i.severity === "block");
  if (blocking.length) {
    throw new HttpError(409, "DRAFT_BLOCKED", `Encore ${blocking.length} point(s) à corriger avant de valider`, blocking.slice(0, 20));
  }

  // 1. Matières utilisées ajoutées à la classe dans le profil (codes vérifiés par l'analyse).
  const used = new Set([
    ...draft.timetable.entries.filter((e) => e.kind === "lesson" && e.subjectCode).map((e) => e.subjectCode!),
    ...draft.curriculum.filter((s) => !s.excluded && s.subjectCode).map((s) => s.subjectCode!),
  ]);
  const assignment = profile.assignments.find((a) => a.classLevel === imp.classLevel);
  if (!assignment) throw badRequest("CLASS_NOT_ASSIGNED", "Cette classe ne fait plus partie de ton profil");
  const missing = [...used].filter((c) => !assignment.subjects.includes(c));
  if (missing.length) {
    assignment.subjects.push(...missing);
    profile.markModified("assignments");
    await profile.save();
  }

  // 2. Emploi du temps versionné (si l'import en contient un ou une proposition acceptée).
  let timetableVersion: number | null = null;
  const lessons = draft.timetable.entries.filter((e) => e.kind === "lesson");
  if (draft.timetable.source !== "none" && lessons.length) {
    const tt = await saveTimetableVersion(
      teacherId,
      imp.classLevel,
      imp.schoolYear,
      {
        slots: lessons.map((e) => ({ weekday: e.weekday!, start: e.start!, end: e.end!, subjectCode: e.subjectCode!, room: e.room, label: e.label })),
        extras: draft.timetable.entries.filter((e) => e.kind !== "lesson").map((e) => ({ weekday: e.weekday!, start: e.start!, end: e.end!, kind: e.kind as "break" | "special", label: e.label || (e.kind === "break" ? "Pause" : "Séance particulière") })),
        source: draft.timetable.source === "proposal" ? "proposal" : "import",
        importId: String(imp._id),
      },
      today
    );
    timetableVersion = tt.version;
  }

  // 3. Progression par matière, avec sa hiérarchie et le point de départ choisi.
  const saved: { subjectCode: string; lessons: number; matched: number }[] = [];
  for (const s of draft.curriculum) {
    if (s.excluded || !s.subjectCode) continue;
    const parents = new Set(s.nodes.map((n) => n.ref));
    const out = await saveImportedCurriculum({
      teacherId,
      classLevel: imp.classLevel,
      subjectCode: s.subjectCode,
      nodes: s.nodes.map((n) => ({ ...n, parentRef: n.parentRef && parents.has(n.parentRef) ? n.parentRef : null })),
      startAt: s.startAt,
      today,
      importId: String(imp._id),
    });
    saved.push({ subjectCode: s.subjectCode, lessons: out.count, matched: out.matched });
  }

  imp.status = "validated";
  imp.validatedAt = new Date();
  imp.timetableVersion = timetableVersion ?? undefined;
  await imp.save();
  return { timetableVersion, proposal: draft.timetable.source === "proposal", subjectsAdded: missing, curriculum: saved };
}

/** Nouvel essai d'un import en échec : la tâche reprend à l'étape échouée (les étapes faites ne sont pas refaites). */
export async function retryImport(teacherId: string, id: string) {
  const imp = await ownImport(teacherId, id);
  if (imp.status !== "failed") throw conflict("IMPORT_NOT_FAILED", "Cet import n'est pas en échec");
  const job = await AiJob.findOne({ _id: imp.jobId, createdBy: teacherId });
  if (!job) throw notFound("Tâche introuvable");
  for (const s of job.steps) if (s.status === "failed" || s.status === "running") {
    s.status = "pending";
    s.attempts = 0;
  }
  job.status = "queued";
  job.nextRunAt = new Date();
  job.lastError = undefined;
  // Nouveau budget pour ce nouvel essai (le budget déjà dépensé reste compté dans le journal).
  job.budgetUsd = job.spentUsd + env.aiImportBudgetUsd;
  await job.save();
  imp.status = "queued";
  imp.error = undefined;
  imp.progress = { ...(imp.progress ?? {}), label: "Nouvel essai…" } as typeof imp.progress;
  await imp.save();
  return String(job._id);
}

/** Abandon (« Recommencer l'import ») : la tâche s'arrête et les fichiers de cet import sont effacés du stockage. */
export async function cancelImport(teacherId: string, id: string) {
  const imp = await ownImport(teacherId, id);
  if (imp.status === "validated") throw conflict("IMPORT_VALIDATED", "Un programme validé ne s'annule pas : importe-en un nouveau");
  imp.status = "cancelled";
  imp.draft = null;
  await imp.save();
  if (imp.jobId) await AiJob.updateOne({ _id: imp.jobId, status: { $in: ["queued", "running"] } }, { status: "cancelled" });
  const uploads = await TeacherUpload.find({ _id: { $in: imp.files.map((f) => f.uploadId) }, teacherId }).select("url key").lean();
  await Promise.all(uploads.map((u) => deleteStoredFile(u.key, u.url)));
  await TeacherUpload.deleteMany({ _id: { $in: uploads.map((u) => u._id) } });
}
