import { Types } from "mongoose";
import { CurriculumNode, LessonInstance, Timetable, subsystemOf, type ClassLevel } from "../models/index.js";

export type ParsedLesson = { title: string; objectives: string[]; term: number | null; week: number | null };

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP = new Set(["le", "la", "les", "de", "des", "du", "d", "l", "et", "a", "au", "aux", "un", "une", "en", "the", "of", "and", "to"]);
const tokens = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w)));

/** Similarité entre deux titres de leçon (indice de Jaccard sur les mots significatifs). */
export function similarity(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Lit une progression collée telle quelle (copiée d'un document, d'un cahier, d'un message) :
 * une leçon par ligne ; « Trimestre 2 », « Semaine 5 » ouvrent une section ; les puces et numéros sont retirés ;
 * « Leçon : objectif 1 ; objectif 2 » sépare titre et objectifs.
 */
export function parseProgression(text: string): ParsedLesson[] {
  const out: ParsedLesson[] = [];
  let term: number | null = null;
  let week: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, " ").trim();
    if (!line) continue;
    const t = line.match(/^(?:trimestre|term|terme)\s*(\d)\b/i);
    if (t) {
      term = Number(t[1]);
      continue;
    }
    const w = line.match(/^(?:semaine|sem\.?|week)\s*(\d{1,2})\s*[:\-–]?\s*(.*)$/i);
    let rest = line;
    if (w) {
      week = Number(w[1]);
      rest = w[2];
      if (!rest) continue;
    }
    rest = rest.replace(/^(?:[-*•–·]|\d{1,3}\s*[.)\-–]|leçon\s*\d+\s*[:.\-–]?|lesson\s*\d+\s*[:.\-–]?)\s*/i, "").trim();
    if (rest.length < 3) continue;
    // « Titre : objectif ; objectif » — mais « Lecture : la famille de Mbarga » reste un seul titre.
    const colon = rest.search(/\s*:\s+/);
    const head = colon > 0 ? rest.slice(0, colon) : rest;
    const tail = colon > 0 ? rest.slice(colon).replace(/^\s*:\s+/, "") : "";
    const split = colon > 0 && (tail.includes(";") || head.split(/\s+/).length >= 3);
    const [title, objs] = split ? [head, tail] : [rest, ""];
    out.push({
      title: title.slice(0, 200),
      objectives: objs ? objs.split(/\s*;\s*/).map((o) => o.trim()).filter((o) => o.length > 2).slice(0, 10) : [],
      term,
      week,
    });
    if (out.length >= 400) break;
  }
  return out;
}

/** Leçons utilisées pour un enseignant : sa progression si elle existe pour la matière, sinon le programme officiel. */
export async function lessonsFor(teacherId: string, classLevel: string, subjects: string[]) {
  const [own, official] = await Promise.all([
    CurriculumNode.find({ ownerId: teacherId, classLevel, subjectCode: { $in: subjects }, kind: "lesson", status: { $ne: "retired" } })
      .sort({ order: 1 })
      .select("_id subjectCode title objectives durationMin term order priority prerequisites matchedNodeId alreadyTaught")
      .lean(),
    CurriculumNode.find({ ownerId: null, classLevel, subjectCode: { $in: subjects }, kind: "lesson", status: { $ne: "retired" } })
      .sort({ order: 1 })
      .select("_id subjectCode title objectives durationMin term order priority prerequisites")
      .lean(),
  ]);
  const map = new Map<string, { source: "mine" | "official"; nodes: typeof official }>();
  for (const s of subjects) {
    const mine = own.filter((n) => n.subjectCode === s);
    map.set(s, mine.length ? { source: "mine", nodes: mine } : { source: "official", nodes: official.filter((n) => n.subjectCode === s) });
  }
  return map;
}

/**
 * Remplace la progression personnelle d'une matière. Chaque leçon est rapprochée d'une leçon officielle
 * (même classe et matière) pour proposer les fiches, exercices et évaluations de la bibliothèque.
 * Les séances futures encore « prévues » sont replanifiées ; le passé (fait, partiel, manqué) est conservé.
 */
export async function saveTeacherCurriculum(teacherId: string, classLevel: string, subjectCode: string, lessons: ParsedLesson[], today: string, startAt = 0) {
  const official = await CurriculumNode.find({ ownerId: null, classLevel, subjectCode, kind: "lesson", status: { $ne: "retired" } })
    .select("_id title objectives durationMin")
    .lean();
  await CurriculumNode.updateMany({ ownerId: teacherId, classLevel, subjectCode, status: { $ne: "retired" } }, { status: "retired" });
  const docs = lessons.map((l, i) => {
    let best: (typeof official)[number] | null = null;
    let score = 0;
    for (const o of official) {
      const s = similarity(l.title, o.title);
      if (s > score) {
        score = s;
        best = o;
      }
    }
    const match = score >= 0.45 ? best : null;
    return {
      ownerId: new Types.ObjectId(teacherId),
      subsystem: subsystemOf(classLevel as ClassLevel),
      classLevel,
      subjectCode,
      kind: "lesson",
      title: l.title,
      objectives: l.objectives.length ? l.objectives : match?.objectives ?? [],
      durationMin: match?.durationMin ?? 45,
      order: i + 1,
      term: l.term ?? undefined,
      priority: /r[ée]vision|evaluation|évaluation|composition/i.test(l.title) ? 3 : 2,
      matchedNodeId: match?._id,
      alreadyTaught: i < startAt,
      curriculumVersion: "enseignant",
      status: "validated",
    };
  });
  const created = docs.length ? await CurriculumNode.insertMany(docs) : [];
  await LessonInstance.deleteMany({ teacherId, classLevel, subjectCode, date: { $gt: today }, status: "planned", origin: "plan" });
  await Timetable.updateMany({ teacherId, classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
  return { count: created.length, matched: docs.filter((d) => d.matchedNodeId).length };
}

/** Revient au programme officiel pour une matière. */
export async function resetTeacherCurriculum(teacherId: string, classLevel: string, subjectCode: string, today: string) {
  await CurriculumNode.updateMany({ ownerId: teacherId, classLevel, subjectCode, status: { $ne: "retired" } }, { status: "retired" });
  await LessonInstance.deleteMany({ teacherId, classLevel, subjectCode, date: { $gt: today }, status: "planned", origin: "plan" });
  await Timetable.updateMany({ teacherId, classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
}
