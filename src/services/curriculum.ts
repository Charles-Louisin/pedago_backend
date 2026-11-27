import { Types } from "mongoose";
import { CurriculumNode, CurriculumPosition, LessonInstance, POSITION_HISTORY_MAX, Timetable, subsystemOf, type ClassLevel } from "../models/index.js";

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

/**
 * Leçons utilisées pour un enseignant : sa progression si elle existe pour la matière, sinon le programme officiel.
 * Si l'enseignant a indiqué où il en est (« Où j'en suis »), les leçons qui précèdent cette position sont marquées
 * `alreadyTaught` (calculé, rien n'est écrit) et `positionSetAt` indique depuis quand la file reprend.
 */
export async function lessonsFor(teacherId: string, classLevel: string, subjects: string[]) {
  const [own, official, positions] = await Promise.all([
    CurriculumNode.find({ ownerId: teacherId, classLevel, subjectCode: { $in: subjects }, kind: "lesson", status: { $ne: "retired" } })
      .sort({ order: 1 })
      .select("_id subjectCode title objectives durationMin term order priority prerequisites matchedNodeId alreadyTaught")
      .lean(),
    CurriculumNode.find({ ownerId: null, classLevel, subjectCode: { $in: subjects }, kind: "lesson", status: { $ne: "retired" } })
      .sort({ order: 1 })
      .select("_id subjectCode title objectives durationMin term order priority prerequisites")
      .lean(),
    CurriculumPosition.find({ teacherId, classLevel, subjectCode: { $in: subjects } }).select("subjectCode nodeId setAt").lean(),
  ]);
  type Node = (typeof official)[number] & { alreadyTaught?: boolean; matchedNodeId?: unknown };
  const map = new Map<string, { source: "mine" | "official"; nodes: Node[]; position: { nodeId: string; setAt: Date } | null }>();
  for (const s of subjects) {
    const mine = own.filter((n) => n.subjectCode === s);
    const nodes: Node[] = mine.length ? mine : official.filter((n) => n.subjectCode === s);
    const pos = positions.find((p) => p.subjectCode === s);
    // Position valable seulement si sa leçon fait partie de la liste en vigueur (une nouvelle progression l'annule).
    const at = pos ? nodes.findIndex((n) => String(n._id) === String(pos.nodeId)) : -1;
    map.set(s, {
      source: mine.length ? "mine" : "official",
      nodes: at === -1 ? nodes : nodes.map((n, i) => ({ ...n, alreadyTaught: i < at })),
      position: at === -1 || !pos ? null : { nodeId: String(pos.nodeId), setAt: pos.setAt },
    });
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
    const match = bestMatch(official, l.title)?.node ?? null;
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

/** Seuil de rapprochement d'un titre de l'enseignant avec une leçon officielle. */
export const MATCH_THRESHOLD = 0.45;

/** Leçon officielle la plus proche d'un titre (null sous le seuil). */
export function bestMatch<T extends { title: string }>(candidates: T[], title: string, threshold = MATCH_THRESHOLD) {
  let best: T | null = null;
  let score = 0;
  for (const c of candidates) {
    const s = similarity(title, c.title);
    if (s > score) {
      score = s;
      best = c;
    }
  }
  return best && score >= threshold ? { node: best, score } : null;
}

/** Nœud de progression importé (déjà vérifié et corrigé par l'enseignant). */
export type ImportedNode = {
  ref: string;
  parentRef: string | null;
  kind: "domain" | "competency" | "unit" | "lesson";
  label: string | null;
  title: string;
  objectives: string[];
  activities: string[];
  assessments: string[];
  prerequisites: string[];
  term: number | null;
  period: string | null;
  week: number | null;
  durationMin: number | null;
  isAssessment: boolean;
};

/**
 * Enregistre une progression importée AVEC sa hiérarchie (domaines, compétences, séquences/unités, leçons).
 * Ce qui vient du document est gardé tel quel : la leçon officielle rapprochée ne sert qu'à retrouver la
 * bibliothèque, et ses objectifs ne complètent la leçon que si le document n'en donne aucun.
 * Comme `saveTeacherCurriculum`, l'ancienne progression est retirée (pas effacée) et le futur replanifié.
 */
export async function saveImportedCurriculum(o: {
  teacherId: string;
  classLevel: string;
  subjectCode: string;
  nodes: ImportedNode[];
  startAt: number;
  today: string;
  importId: string;
}) {
  const { teacherId, classLevel, subjectCode } = o;
  const official = await CurriculumNode.find({ ownerId: null, classLevel, subjectCode, kind: "lesson", status: { $ne: "retired" } })
    .select("_id title objectives durationMin")
    .lean();
  await CurriculumNode.updateMany({ ownerId: teacherId, classLevel, subjectCode, status: { $ne: "retired" } }, { status: "retired" });
  const subsystem = subsystemOf(classLevel as ClassLevel);
  const idByRef = new Map<string, Types.ObjectId>();
  const titleById: { id: Types.ObjectId; title: string }[] = [];
  let lessonIndex = 0;
  let matched = 0;
  const docs = o.nodes.map((n, i) => {
    const _id = new Types.ObjectId();
    idByRef.set(n.ref, _id);
    const isLesson = n.kind === "lesson";
    const match = isLesson ? bestMatch(official, n.title)?.node ?? null : null;
    if (match) matched++;
    const position = isLesson ? lessonIndex++ : -1;
    if (isLesson) titleById.push({ id: _id, title: n.title });
    return {
      _id,
      ownerId: new Types.ObjectId(teacherId),
      subsystem,
      classLevel,
      subjectCode,
      kind: n.kind,
      parentRef: n.parentRef,
      label: n.label ?? undefined,
      title: n.title,
      objectives: n.objectives.length ? n.objectives : match?.objectives ?? [],
      activities: n.activities.length ? n.activities : undefined,
      assessments: n.assessments.length ? n.assessments : undefined,
      prerequisiteNotes: n.prerequisites.length ? n.prerequisites : undefined,
      durationMin: n.durationMin ?? match?.durationMin ?? 45,
      durationStated: n.durationMin != null,
      order: isLesson ? position + 1 : i + 1,
      term: n.term ?? undefined,
      period: n.period ?? undefined,
      week: n.week ?? undefined,
      priority: n.isAssessment || /r[ée]vision|evaluation|évaluation|composition|revision|assessment/i.test(n.title) ? 3 : 2,
      matchedNodeId: match?._id,
      alreadyTaught: isLesson && position < o.startAt,
      curriculumVersion: "enseignant",
      status: "validated",
      importId: new Types.ObjectId(o.importId),
    };
  });
  // Parents et prérequis résolus une fois tous les identifiants connus (prérequis cités par leur titre).
  const rows = docs.map(({ parentRef, prerequisiteNotes, ...d }) => ({
    ...d,
    prerequisiteNotes,
    parentId: parentRef ? idByRef.get(parentRef) : undefined,
    prerequisites: (prerequisiteNotes ?? []).flatMap((t) => {
      const m = bestMatch(titleById, t, 0.6);
      return m && !m.node.id.equals(d._id) ? [m.node.id] : [];
    }),
  }));
  if (rows.length) await CurriculumNode.insertMany(rows);
  await LessonInstance.deleteMany({ teacherId, classLevel, subjectCode, date: { $gt: o.today }, status: "planned", origin: "plan" });
  await Timetable.updateMany({ teacherId, classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
  return { count: lessonIndex, nodes: rows.length, matched };
}

/** Revient au programme officiel pour une matière. */
export async function resetTeacherCurriculum(teacherId: string, classLevel: string, subjectCode: string, today: string) {
  await CurriculumNode.updateMany({ ownerId: teacherId, classLevel, subjectCode, status: { $ne: "retired" } }, { status: "retired" });
  await LessonInstance.deleteMany({ teacherId, classLevel, subjectCode, date: { $gt: today }, status: "planned", origin: "plan" });
  await Timetable.updateMany({ teacherId, classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
}

/**
 * Règle « Où j'en suis » pour une matière : la leçon choisie devient la prochaine à faire, tout ce qui précède compte
 * comme déjà enseigné (aucun bilan n'est créé). Les séances prévues à partir de maintenant sont recalculées par le
 * moteur de planification (sans IA) ; le passé n'est pas touché. La position précédente est gardée (retour possible).
 * `nodeId` à null : revient à la position précédente (ou à aucune).
 */
export async function setCurriculumPosition(o: { teacherId: string; classLevel: string; subjectCode: string; nodeId: string | null; today: string; now?: string }) {
  const { teacherId, classLevel, subjectCode } = o;
  const current = await CurriculumPosition.findOne({ teacherId, classLevel, subjectCode });
  let target: string | null = o.nodeId;
  if (target) {
    const entry = (await lessonsFor(teacherId, classLevel, [subjectCode])).get(subjectCode);
    if (!entry?.nodes.some((n) => String(n._id) === target)) return null;
  }
  const setAt = new Date();
  if (o.nodeId === null) {
    // Retour en arrière : la dernière position de l'historique, ou plus de position du tout.
    const prev = current?.history.at(-1);
    target = prev?.nodeId ? String(prev.nodeId) : null;
    if (current) {
      if (target) {
        current.nodeId = new Types.ObjectId(target);
        current.setAt = setAt;
        current.history.pop();
        await current.save();
      } else await current.deleteOne();
    }
  } else if (current) {
    if (String(current.nodeId) !== target) {
      current.history.push({ nodeId: current.nodeId, setAt: current.setAt });
      if (current.history.length > POSITION_HISTORY_MAX) current.history.splice(0, current.history.length - POSITION_HISTORY_MAX);
    }
    current.nodeId = new Types.ObjectId(target!);
    current.setAt = setAt;
    await current.save();
  } else {
    await CurriculumPosition.create({ teacherId, classLevel, subjectCode, nodeId: target, setAt, history: [] });
  }
  // Séances encore « prévues » de la matière, à partir de maintenant : recalculées. Celles d'aujourd'hui déjà
  // commencées restent (elles appartiennent au bilan du jour).
  const fromNow = o.now ? [{ date: { $gt: o.today } }, { date: o.today, start: { $gte: o.now } }] : [{ date: { $gte: o.today } }];
  await LessonInstance.deleteMany({ teacherId, classLevel, subjectCode, status: "planned", origin: "plan", $or: fromNow });
  await Timetable.updateMany({ teacherId, classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
  const after = await CurriculumPosition.findOne({ teacherId, classLevel, subjectCode }).lean();
  // Retour possible tant qu’une position existe (au pire, retour à « aucune position »).
  return { nodeId: after ? String(after.nodeId) : null, canUndo: Boolean(after) };
}

/** Nœud d'une progression lue AVEC sa hiérarchie (domaine → compétence → séquence/unité → leçon), sans IA. */
export type ParsedTreeNode = {
  kind: "domain" | "competency" | "unit" | "lesson";
  /** Intitulé tel qu'écrit (« Séquence 1 », « Unité 2 ») pour une unité. */
  label: string | null;
  title: string;
  /** Index du parent dans la liste (null : racine). */
  parent: number | null;
  objectives: string[];
  activities: string[];
  prerequisites: string[];
  term: number | null;
  week: number | null;
  durationMin: number | null;
  isAssessment: boolean;
};

// Séparateurs acceptés après un intitulé : tiret court ou long, deux-points, point.
const RE_DOMAIN = /^(?:domaine|domain)\s*[:：]\s*(.+)$/i;
const RE_COMPETENCY = /^(?:comp[ée]tences?|competency|competencies)\s*[:：]\s*(.+)$/i;
const RE_UNIT = /^((?:s[ée]quence|unit[ée]?|chapitre|chapter|module|th[èe]me|theme)\s*(?:\d+|[IVX]+)?)\s*[-–—:.]\s*(.+)$/i;
const RE_TERM = /^(?:trimestre|term|terme)\s*(\d)\b\s*$/i;
const RE_WEEK = /^(?:semaine|sem\.?|week)\s*(\d{1,2})\s*[-–—:.]?\s*(.*)$/i;
const RE_LESSON_PREFIX = /^(?:[-*•–—·]\s*)?(?:le[çc]on|lesson)\s*\d+\s*[-–—:.]?\s*/i;
const SECTIONS = /\.\s+(?=(?:objectifs?|objectives?|activit[ée]s?|activities|activity|pr[ée]requis|prerequisites?|dur[ée]e|duration)\s*:)/i;

/**
 * Lit une progression collée ou extraite d'un document en gardant ses niveaux : « Domaine : … », « Compétence : … »,
 * « Séquence 1 : … » (ou Unité, Chapitre, Module, Thème), « Trimestre 2 », « Semaine 5 — Leçon 4 : … ».
 * Sur une ligne de leçon, « Objectifs : a ; b », « Activité : … », « Prérequis : … », « Durée : 45 min » sont rangés à part.
 * Rien n'est inventé : sans niveau écrit, les leçons sont à la racine.
 */
export function parseProgressionTree(text: string): ParsedTreeNode[] {
  const out: ParsedTreeNode[] = [];
  let term: number | null = null;
  let domain: number | null = null;
  let competency: number | null = null;
  let unit: number | null = null;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  lines.forEach((line, i) => {
    // Titre du document (« PROGRESSION ANNUELLE DE … ») : ignoré.
    if (i === 0 && /^(progression|scheme of work|programme)\b/i.test(line)) return;
    const t = line.match(RE_TERM);
    if (t) return void (term = Number(t[1]));
    const base = { objectives: [], activities: [], prerequisites: [], term, week: null, durationMin: null, isAssessment: false };
    const d = line.match(RE_DOMAIN);
    if (d) {
      out.push({ ...base, kind: "domain", label: null, title: d[1].slice(0, 200), parent: null });
      domain = out.length - 1;
      competency = unit = null;
      return;
    }
    const c = line.match(RE_COMPETENCY);
    if (c) {
      out.push({ ...base, kind: "competency", label: null, title: c[1].slice(0, 200), parent: domain });
      competency = out.length - 1;
      unit = null;
      return;
    }
    const u = line.match(RE_UNIT);
    if (u && !RE_LESSON_PREFIX.test(line)) {
      out.push({ ...base, kind: "unit", label: u[1].replace(/\s+/g, " ").trim().slice(0, 80), title: u[2].slice(0, 200), parent: competency ?? domain });
      unit = out.length - 1;
      return;
    }
    let rest = line;
    let week: number | null = null;
    const w = rest.match(RE_WEEK);
    if (w) {
      week = Number(w[1]);
      rest = w[2];
      if (!rest) return;
    }
    rest = rest.replace(RE_LESSON_PREFIX, "").replace(/^[-*•–—·]\s*/, "").trim();
    if (rest.length < 3) return;
    const [head, ...parts] = rest.split(SECTIONS);
    const node: ParsedTreeNode = { ...base, kind: "lesson", label: null, title: head.replace(/\.$/, "").trim().slice(0, 200), parent: unit ?? competency ?? domain, week };
    for (const p of parts) {
      const [key, ...val] = p.split(":");
      const v = val.join(":").trim().replace(/\.$/, "");
      if (/^objecti/i.test(key)) node.objectives = v.split(/\s*;\s*/).filter((x) => x.length > 2).slice(0, 10);
      else if (/^activ/i.test(key)) node.activities = [v.slice(0, 300)];
      else if (/^pr[ée]req/i.test(key)) node.prerequisites = v.split(/\s*;\s*/).filter(Boolean).slice(0, 5);
      else if (/^dur/i.test(key)) node.durationMin = Number(v.match(/\d+/)?.[0]) || null;
    }
    node.isAssessment = /^(?:[ée]valuation|assessment|composition|r[ée]vision|revision)\b/i.test(node.title);
    out.push(node);
    if (out.length >= 800) return;
  });
  return out;
}
