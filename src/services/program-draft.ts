import { z } from "zod";
import { CurriculumNode, LessonInstance, Subject, TeacherProfile, subsystemOf, type ClassLevel, type Subsystem } from "../models/index.js";
import { addDays, minutesBetween, weekday } from "../utils/dates.js";
import { bestMatch, similarity } from "./curriculum.js";
import { distributeLessons, getCalendar, isSchoolDay } from "./planning.js";

/**
 * Brouillon d'un import « Mon programme » : partie MODIFIABLE (créneaux, listes de leçons, point de départ)
 * et partie CALCULÉE à chaque lecture ou correction, sans IA (contrôles, rapprochement avec le programme
 * national, répartition, aperçu de la progression, récapitulatif).
 *
 * Principes : ce qui vient du document de l'enseignant n'est jamais remplacé par une supposition ;
 * un doute est signalé (« à vérifier ») plutôt que tranché en silence ; une proposition est marquée comme telle.
 */

/* ───────────── Partie modifiable ───────────── */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = (max: number) => z.string().trim().max(max);
const list = (item: number, n: number) => z.array(text(item)).max(n).default([]);

export const draftEntrySchema = z.object({
  id: text(40).min(1),
  weekday: z.number().int().min(1).max(6).nullable(),
  start: z.string().regex(HHMM).nullable(),
  end: z.string().regex(HHMM).nullable(),
  kind: z.enum(["lesson", "break", "special"]),
  /** Intitulé tel qu'écrit sur le document. */
  label: text(120),
  subjectCode: text(40).nullable(),
  room: text(80).nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  doubt: text(300).nullable().default(null),
  /** L'enseignant a vu le doute et confirme la lecture. */
  confirmed: z.boolean().default(false),
  /** L'enseignant a corrigé l'élément (il fait foi). */
  edited: z.boolean().default(false),
  file: z.number().int().min(1).max(20).nullable().default(null),
});
export type DraftEntry = z.infer<typeof draftEntrySchema>;

export const draftNodeSchema = z.object({
  ref: text(40).min(1),
  parentRef: text(40).nullable().default(null),
  kind: z.enum(["domain", "competency", "unit", "lesson"]),
  label: text(80).nullable().default(null),
  title: text(240),
  objectives: list(400, 20),
  activities: list(400, 20),
  assessments: list(400, 12),
  prerequisites: list(240, 12),
  term: z.number().int().min(1).max(3).nullable().default(null),
  period: text(80).nullable().default(null),
  week: z.number().int().min(1).max(60).nullable().default(null),
  durationMin: z.number().int().min(5).max(600).nullable().default(null),
  isAssessment: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(1),
  doubt: text(300).nullable().default(null),
  confirmed: z.boolean().default(false),
  edited: z.boolean().default(false),
  file: z.number().int().min(1).max(20).nullable().default(null),
});
export type DraftNode = z.infer<typeof draftNodeSchema>;

export const draftSubjectSchema = z.object({
  key: text(40).min(1),
  subjectCode: text(40).nullable(),
  /** Nom de la matière tel qu'écrit sur le document. */
  writtenName: text(160),
  classLevelWritten: text(40).nullable().default(null),
  /** Nombre de leçons déjà faites avant aujourd'hui (comptées comme faites, non replanifiées). */
  startAt: z.number().int().min(0).max(800).default(0),
  excluded: z.boolean().default(false),
  nodes: z.array(draftNodeSchema).max(800),
});
export type DraftSubject = z.infer<typeof draftSubjectSchema>;

export const editableDraftSchema = z.object({
  timetable: z.object({
    /** « document » : lu sur les documents ; « proposal » : répartition proposée (pas l'emploi du temps officiel). */
    source: z.enum(["document", "proposal", "none"]),
    entries: z.array(draftEntrySchema).max(120),
  }),
  curriculum: z.array(draftSubjectSchema).max(20),
  /** Remarques du lecteur (modèle ou lecture directe) : informatives. */
  notes: z.array(text(400)).max(30).default([]),
});
export type EditableDraft = z.infer<typeof editableDraftSchema>;

/* ───────────── Contexte (base de données) ───────────── */

export type DraftContext = {
  classLevel: string;
  subsystem: Subsystem;
  schoolYear: string;
  today: string;
  subjects: { code: string; name: string }[];
  profileSubjects: string[];
  official: Map<string, { _id: string; title: string; order: number; prerequisites: string[] }[]>;
  /** Titres des leçons déjà faites ou partielles (bilans), par matière, dans l'ordre chronologique. */
  doneTitles: Map<string, string[]>;
  calendar: { startsOn: string; endsOn: string; breaks: { startsOn: string; endsOn: string }[] } | null;
  /** Remarques venues du classement (« rangé en curriculum, ressemble à un emploi du temps »). */
  classifyNotes: string[];
};

export async function loadDraftContext(teacherId: string, classLevel: string, schoolYear: string, today: string, classifyNotes: string[] = []): Promise<DraftContext> {
  const subsystem = subsystemOf(classLevel as ClassLevel);
  const [subjects, profile, official, done, calendar] = await Promise.all([
    Subject.find({ subsystem }).sort({ order: 1 }).select("code name").lean(),
    TeacherProfile.findOne({ userId: teacherId }).select("assignments").lean(),
    CurriculumNode.find({ ownerId: null, classLevel, kind: "lesson", status: { $ne: "retired" } }).sort({ order: 1 }).select("_id subjectCode title order prerequisites").lean(),
    LessonInstance.find({ teacherId, classLevel, status: { $in: ["done", "partial"] } })
      .sort({ date: 1, start: 1 })
      .select("subjectCode nodeId")
      .populate<{ nodeId: { title: string } | null }>("nodeId", "title")
      .lean(),
    getCalendar(schoolYear),
  ]);
  const officialMap = new Map<string, { _id: string; title: string; order: number; prerequisites: string[] }[]>();
  for (const n of official) {
    const arr = officialMap.get(n.subjectCode) ?? [];
    arr.push({ _id: String(n._id), title: n.title, order: n.order, prerequisites: (n.prerequisites ?? []).map(String) });
    officialMap.set(n.subjectCode, arr);
  }
  const doneTitles = new Map<string, string[]>();
  for (const l of done) if (l.nodeId?.title) doneTitles.set(l.subjectCode, [...(doneTitles.get(l.subjectCode) ?? []), l.nodeId.title]);
  return {
    classLevel,
    subsystem,
    schoolYear,
    today,
    subjects: subjects.map((s) => ({ code: s.code, name: s.name })),
    profileSubjects: profile?.assignments.find((a) => a.classLevel === classLevel)?.subjects ?? [],
    official: officialMap,
    doneTitles,
    calendar,
    classifyNotes,
  };
}

/* ───────────── Lecture des heures et des matières ───────────── */

/** « 7h30 », « 07H30 », « 7:30 », « 7.30 », « 7h » → « 07:30 » ; null si ce n'est pas une heure. Aucune heure n'est devinée. */
export function normalizeTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2})\s*(?:[hH:.]\s*(\d{2})?|[hH])\s*(?:mn|min)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Intitulés usuels des emplois du temps camerounais → matière (l'intitulé écrit est toujours gardé à côté). */
const ALIASES: Record<Subsystem, [string, RegExp][]> = {
  francophone: [
    ["SHS", /\b(histoire|geographie|civique|morale|citoyennete|sciences humaines|shs|ecm|education a la citoyennete)\b/],
    ["LCN", /\b(langues? nationales?|cultures? nationales?|lcn)\b/],
    ["EN", /\b(anglais|english)\b/],
    ["TIC", /\b(informatique|tic|tice|numerique)\b/],
    ["EPS", /\b(eps|education physique|sport|gymnastique)\b/],
    ["MATH", /\b(math\w*|calcul\w*|numeration|geometrie|mesures?|arithmetique|problemes?)\b/],
    ["FR", /\b(francais|lecture|ecriture|dictee|grammaire|conjugaison|orthographe|vocabulaire|expression (ecrite|orale)|redaction|recitation|langage|copie|graphisme|elocution|langue et communication|production d ecrits)\b/],
    ["SCI", /\b(sciences?|technologie|hygiene|sante|environnement|observation|lecons? de choses)\b/],
    ["ART", /\b(dessin|chant|musique|arts?|artistique|travail manuel|travaux manuels|bricolage|poterie)\b/],
  ],
  anglophone: [
    ["SOC", /\b(social studies|social|history|geography|citizenship|civics?|moral)\b/],
    ["NLC", /\b(national languages?|cultures?|nlc)\b/],
    ["FRE", /\b(french|francais)\b/],
    ["ICT", /\b(ict|computer|informatics)\b/],
    ["PE", /\b(pe|physical education|sports?|games)\b/],
    ["MATH", /\b(math\w*|arithmetic|numbers?|geometry|measurement)\b/],
    ["ENG", /\b(english|reading|writing|spelling|dictation|grammar|composition|phonics|handwriting|comprehension|recitation|poems?)\b/],
    ["SCI", /\b(science|health|hygiene|technology|environment)\b/],
    ["ART", /\b(arts?|drawing|music|singing|crafts?|handwork)\b/],
  ],
};

/**
 * Matière d'un intitulé : code exact, nom officiel proche, ou intitulé usuel. Une case qui cite deux
 * matières différentes (« Lecture / Calcul ») n'est rattachée à aucune : l'enseignant tranche.
 */
export function matchSubject(label: string, subsystem: Subsystem, subjects: { code: string; name: string }[]) {
  const n = norm(label);
  if (!n) return { code: null as string | null, ambiguous: false };
  const exact = subjects.find((s) => norm(s.code) === n || norm(s.name) === n);
  if (exact) return { code: exact.code, ambiguous: false };
  const codes = new Set<string>();
  for (const [code, re] of ALIASES[subsystem]) if (re.test(n)) codes.add(code);
  // Une même case « Lecture / Écriture » reste une seule matière (français) : ambiguïté seulement si 2 codes.
  const valid = [...codes].filter((c) => subjects.some((s) => s.code === c));
  if (valid.length === 1) return { code: valid[0], ambiguous: false };
  if (valid.length > 1) {
    // « Sciences humaines » contient « sciences » : le motif le plus spécifique (listé d'abord) gagne s'il couvre tout.
    const first = ALIASES[subsystem].find(([c]) => valid.includes(c))![0];
    const sep = /\s\/\s|\/|,|\bet\b|\band\b|\+/.test(label);
    return sep ? { code: null, ambiguous: true } : { code: first, ambiguous: false };
  }
  const near = subjects.map((s) => ({ s, score: similarity(label, s.name) })).sort((a, b) => b.score - a.score)[0];
  return near && near.score >= 0.5 ? { code: near.s.code, ambiguous: false } : { code: null, ambiguous: false };
}

/* ───────────── Contrôles ───────────── */

export type Severity = "block" | "check" | "info";
export type Issue = { code: string; severity: Severity; message: string; entryId?: string; subjectKey?: string; nodeRef?: string };

const DAY_NAMES = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const CONFIDENCE_CHECK = 0.75;

function overlap(a: DraftEntry, b: DraftEntry) {
  return a.weekday === b.weekday && a.start && a.end && b.start && b.end && a.start < b.end && b.start < a.end;
}

function timetableIssues(entries: DraftEntry[], ctx: DraftContext): Issue[] {
  const issues: Issue[] = [];
  const known = new Set(ctx.subjects.map((s) => s.code));
  for (const e of entries) {
    const where = `${e.label || "Créneau"}${e.weekday ? ` (${DAY_NAMES[e.weekday]}${e.start ? ` ${e.start}` : ""})` : ""}`;
    const add = (code: string, severity: Severity, message: string) => issues.push({ code, severity: severity === "check" && e.confirmed ? "info" : severity, message, entryId: e.id });
    if (!e.weekday) add("DAY_MISSING", "block", `${where} : jour illisible, à choisir.`);
    if (!e.start || !e.end) add("TIME_MISSING", "block", `${where} : heure ${!e.start ? "de début" : "de fin"} absente du document, à compléter (PEDAGO ne l'invente pas).`);
    if (e.start && e.end) {
      const d = minutesBetween(e.start, e.end);
      if (d <= 0) add("TIME_ORDER", "block", `${where} : la fin (${e.end}) n'est pas après le début (${e.start}).`);
      else if (e.kind === "lesson" && d < 20)
        // Rituel court (calcul mental, dictée du jour…) : gardé tel qu'écrit, mais l'enseignant décide s'il reçoit une leçon.
        add("SHORT_SLOT", "check", `${where} : séance courte (${d} min), une leçon entière de la progression y sera placée. Si c'est un rituel (calcul mental…), passe-la en « séance particulière ».`);
      else if (e.kind === "lesson" && d > 240) add("DURATION_ODD", "check", `${where} : durée inhabituelle (${d} min).`);
      if (e.start < "06:00" || e.end > "19:00") add("HOUR_ODD", "check", `${where} : horaire inhabituel pour l'école (${e.start}–${e.end}).`);
    }
    if (e.kind === "lesson") {
      if (!e.subjectCode) add("SUBJECT_MISSING", "block", `${where} : matière à choisir${e.doubt ? ` (${e.doubt})` : ""}.`);
      else if (!known.has(e.subjectCode)) add("SUBJECT_UNKNOWN", "block", `${where} : matière inconnue pour ce sous-système, à choisir.`);
      else if (!ctx.profileSubjects.includes(e.subjectCode)) add("SUBJECT_NEW", "info", `${where} : matière absente de ton profil, elle y sera ajoutée.`);
    }
    if (!e.edited && e.confidence < CONFIDENCE_CHECK) add("LOW_CONFIDENCE", "check", `${where} : lecture incertaine${e.doubt ? ` — ${e.doubt}` : ""}.`);
    else if (!e.edited && e.doubt) add("DOUBT", "check", `${where} : ${e.doubt}`);
  }
  // Chevauchements : jamais tranchés en silence, même pour deux matières écrites dans la même case.
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (!overlap(a, b)) continue;
      const same = a.start === b.start && a.end === b.end && a.label === b.label && a.subjectCode === b.subjectCode;
      issues.push({
        code: same ? "DUPLICATE" : "OVERLAP",
        severity: "block",
        message: same
          ? `« ${a.label} » apparaît deux fois le ${DAY_NAMES[a.weekday!]} à ${a.start} : supprime le doublon.`
          : `Le ${DAY_NAMES[a.weekday!]}, « ${a.label} » (${a.start}–${a.end}) et « ${b.label} » (${b.start}–${b.end}) se chevauchent : garde le bon.`,
        entryId: b.id,
      });
    }
  return issues;
}

function curriculumIssues(subjects: DraftSubject[], ctx: DraftContext, slotSubjects: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const known = new Set(ctx.subjects.map((s) => s.code));
  const seen = new Map<string, string>();
  for (const s of subjects) {
    if (s.excluded) continue;
    const name = s.writtenName || "Matière";
    const lessons = s.nodes.filter((n) => n.kind === "lesson");
    if (!s.subjectCode) issues.push({ code: "SUBJECT_MISSING", severity: "block", message: `« ${name} » : choisis la matière correspondante, ou exclus cette liste.`, subjectKey: s.key });
    else if (!known.has(s.subjectCode)) issues.push({ code: "SUBJECT_UNKNOWN", severity: "block", message: `« ${name} » : matière inconnue pour ce sous-système.`, subjectKey: s.key });
    else if (seen.has(s.subjectCode))
      issues.push({ code: "SUBJECT_TWICE", severity: "block", message: `« ${name} » et « ${seen.get(s.subjectCode)} » sont rangées dans la même matière : exclus-en une.`, subjectKey: s.key });
    if (s.subjectCode) seen.set(s.subjectCode, name);
    if (!lessons.length) issues.push({ code: "NO_LESSON", severity: "block", message: `« ${name} » : aucune leçon lue. Exclus cette liste ou ajoute ses leçons.`, subjectKey: s.key });
    if (s.classLevelWritten && norm(s.classLevelWritten) !== norm(ctx.classLevel) && !norm(s.classLevelWritten).includes(norm(ctx.classLevel).replace(/^class /, "")))
      issues.push({ code: "CLASS_DIFFERS", severity: "check", message: `« ${name} » : le document indique la classe « ${s.classLevelWritten} ».`, subjectKey: s.key });
    if (s.subjectCode && slotSubjects.size && !slotSubjects.has(s.subjectCode))
      issues.push({ code: "NO_SLOT", severity: "check", message: `« ${name} » : aucun créneau dans l'emploi du temps, ses leçons ne seront pas planifiées.`, subjectKey: s.key });
    const refs = new Set(s.nodes.map((n) => n.ref));
    for (const n of s.nodes) {
      const add = (code: string, severity: Severity, message: string) =>
        issues.push({ code, severity: severity === "check" && n.confirmed ? "info" : severity, message, subjectKey: s.key, nodeRef: n.ref });
      const where = `${name} · ${n.label ? `${n.label} : ` : ""}${n.title || "sans titre"}`;
      if (n.title.length < 2) add("TITLE_MISSING", "block", `${name} : un élément n'a pas de titre lisible, complète-le ou supprime-le.`);
      if (n.parentRef && !refs.has(n.parentRef)) add("PARENT_MISSING", "info", `${where} : rattachement au niveau supérieur perdu (placé à la racine).`);
      if (n.durationMin != null && (n.durationMin < 10 || n.durationMin > 300)) add("DURATION_ODD", "check", `${where} : durée écrite inhabituelle (${n.durationMin} min).`);
      if (!n.edited && n.confidence < CONFIDENCE_CHECK) add("LOW_CONFIDENCE", "check", `${where} : lecture incertaine${n.doubt ? ` — ${n.doubt}` : ""}.`);
      else if (!n.edited && n.doubt) add("DOUBT", "check", `${where} : ${n.doubt}`);
    }
  }
  return issues;
}

/* ───────────── Rapprochement avec le programme national ───────────── */

export type Reconciliation = {
  subjectKey: string;
  subjectCode: string;
  official: number;
  matched: number;
  /** Leçons du programme national absentes du document (signalées, jamais ajoutées). */
  gaps: string[];
  /** Leçons du document sans équivalent national (normal pour une progression personnelle). */
  unmatched: number;
  /** Ordre contraire au programme national alors qu'un prérequis est en jeu. */
  orderIssues: string[];
  matches: Record<string, { id: string; title: string; score: number }>;
};

function reconcile(s: DraftSubject, ctx: DraftContext): Reconciliation | null {
  if (!s.subjectCode || s.excluded) return null;
  const official = ctx.official.get(s.subjectCode) ?? [];
  const lessons = s.nodes.filter((n) => n.kind === "lesson");
  const matches: Reconciliation["matches"] = {};
  const used = new Set<string>();
  for (const l of lessons) {
    const m = bestMatch(official, l.title);
    if (m) {
      matches[l.ref] = { id: m.node._id, title: m.node.title, score: Math.round(m.score * 100) / 100 };
      used.add(m.node._id);
    }
  }
  const orderIssues: string[] = [];
  // Position dans le document de chaque leçon officielle rapprochée.
  const pos = new Map<string, { index: number; title: string }>();
  lessons.forEach((l, i) => {
    const m = matches[l.ref];
    if (m && !pos.has(m.id)) pos.set(m.id, { index: i, title: l.title });
  });
  for (const o of official) {
    const here = pos.get(o._id);
    if (!here) continue;
    for (const pre of o.prerequisites) {
      const before = pos.get(pre);
      if (before && before.index > here.index) orderIssues.push(`« ${here.title} » vient avant « ${before.title} », qui la prépare dans le programme national.`);
    }
  }
  return {
    subjectKey: s.key,
    subjectCode: s.subjectCode,
    official: official.length,
    matched: used.size,
    gaps: official.filter((o) => !used.has(o._id)).map((o) => o.title),
    unmatched: lessons.length - Object.keys(matches).length,
    orderIssues: orderIssues.slice(0, 10),
    matches,
  };
}

/** Point de départ suggéré d'après les bilans déjà faits : la leçon qui suit la dernière faite retrouvée. */
function startHint(s: DraftSubject, ctx: DraftContext) {
  if (!s.subjectCode) return null;
  const done = ctx.doneTitles.get(s.subjectCode) ?? [];
  if (!done.length) return null;
  const lessons = s.nodes.filter((n) => n.kind === "lesson");
  let last = -1;
  lessons.forEach((l, i) => {
    if (done.some((t) => similarity(t, l.title) >= 0.6)) last = i;
  });
  return last >= 0 ? last + 1 : null;
}

/* ───────────── Proposition de répartition (curriculum seul) ───────────── */

/** Grille horaire type d'une journée de classe : utilisée SEULEMENT pour une proposition, jamais présentée comme officielle. */
const PROPOSAL_GRID: [string, string][] = [
  ["07:30", "08:30"],
  ["08:30", "09:30"],
  ["09:30", "10:30"],
  ["11:00", "12:00"],
  ["12:00", "13:00"],
  ["14:00", "15:00"],
];

function schoolWeeksLeft(ctx: DraftContext) {
  const end = ctx.calendar?.endsOn ?? addDays(ctx.today, 270);
  let days = 0;
  for (let d = ctx.today; d <= end && days < 400; d = addDays(d, 1)) if (isSchoolDay(ctx.calendar, d) && weekday(d) <= 5) days++;
  return Math.max(4, Math.round(days / 5));
}

/**
 * Répartition PROPOSÉE quand le curriculum arrive sans emploi du temps : nombre de séances par semaine
 * d'après les semaines indiquées dans le document (sinon d'après le nombre de leçons et les semaines
 * de classe restantes), puis créneaux répartis sur la semaine. Marquée « proposal » partout.
 */
export function proposeTimetable(subjects: DraftSubject[], ctx: DraftContext): DraftEntry[] {
  const weeks = schoolWeeksLeft(ctx);
  const wanted = subjects
    .filter((s) => !s.excluded && s.subjectCode)
    .map((s) => {
      const lessons = s.nodes.filter((n) => n.kind === "lesson").slice(s.startAt);
      const byWeek = new Map<number, number>();
      for (const l of lessons) if (l.week) byWeek.set(l.week, (byWeek.get(l.week) ?? 0) + 1);
      const perWeek = byWeek.size >= 3 ? Math.max(...byWeek.values()) : Math.ceil(lessons.length / weeks);
      return { code: s.subjectCode!, label: s.writtenName, perWeek: Math.min(10, Math.max(1, perWeek)) };
    });
  const capacity = PROPOSAL_GRID.length * 5;
  let total = wanted.reduce((n, w) => n + w.perWeek, 0);
  // Trop de séances pour une semaine : réduction proportionnelle (au moins une séance par matière).
  while (total > capacity) {
    const biggest = wanted.reduce((a, b) => (b.perWeek > a.perWeek ? b : a));
    if (biggest.perWeek <= 1) break;
    biggest.perWeek -= 1;
    total -= 1;
  }
  const cells: { weekday: number; slot: number }[] = [];
  for (let slot = 0; slot < PROPOSAL_GRID.length; slot++) for (let d = 1; d <= 5; d++) cells.push({ weekday: d, slot });
  const out: DraftEntry[] = [];
  const used = new Set<string>();
  // Séances d'une même matière étalées sur des jours différents ; les matières les plus chargées d'abord, le matin.
  for (const w of [...wanted].sort((a, b) => b.perWeek - a.perWeek)) {
    const days = new Set<number>();
    for (let k = 0; k < w.perWeek; k++) {
      const cell = cells.find((c) => !used.has(`${c.weekday}|${c.slot}`) && !days.has(c.weekday)) ?? cells.find((c) => !used.has(`${c.weekday}|${c.slot}`));
      if (!cell) break;
      used.add(`${cell.weekday}|${cell.slot}`);
      days.add(cell.weekday);
      out.push({
        id: `p${out.length + 1}`,
        weekday: cell.weekday,
        start: PROPOSAL_GRID[cell.slot][0],
        end: PROPOSAL_GRID[cell.slot][1],
        kind: "lesson",
        label: w.label,
        subjectCode: w.code,
        room: null,
        confidence: 1,
        doubt: null,
        confirmed: false,
        edited: false,
        file: null,
      });
    }
  }
  for (let d = 1; d <= 5; d++)
    out.push({ id: `p${out.length + 1}`, weekday: d, start: "10:30", end: "11:00", kind: "break", label: "Récréation (proposée)", subjectCode: null, room: null, confidence: 1, doubt: null, confirmed: false, edited: false, file: null });
  return out.sort((a, b) => a.weekday! - b.weekday! || a.start!.localeCompare(b.start!));
}

/* ───────────── Aperçu de la progression (sans rien écrire) ───────────── */

export type SubjectPlan = {
  subjectCode: string;
  source: "document" | "official" | "none";
  sessionsPerWeek: number;
  minutesPerWeek: number;
  lessons: number;
  alreadyDone: number;
  planned: number;
  /** Leçons qui ne tiennent pas avant la fin de l'année scolaire. */
  overflow: number;
  firstDate: string | null;
  lastDate: string | null;
  upcoming: { date: string; start: string; title: string }[];
};

function previewProgression(entries: DraftEntry[], subjects: DraftSubject[], ctx: DraftContext): SubjectPlan[] {
  const slots = entries
    .filter((e) => e.kind === "lesson" && e.subjectCode && e.weekday && e.start && e.end && e.start < e.end)
    .map((e) => ({ weekday: e.weekday!, start: e.start!, end: e.end!, subjectCode: e.subjectCode! }));
  const codes = [...new Set([...slots.map((s) => s.subjectCode), ...subjects.filter((s) => !s.excluded && s.subjectCode).map((s) => s.subjectCode!)])];
  const cursors = new Map<string, { nodes: { title: string }[]; next: number }>();
  const meta = new Map<string, { source: SubjectPlan["source"]; total: number; done: number }>();
  for (const code of codes) {
    const own = subjects.find((s) => !s.excluded && s.subjectCode === code);
    if (own) {
      const lessons = own.nodes.filter((n) => n.kind === "lesson");
      const done = Math.min(own.startAt, lessons.length);
      cursors.set(code, { nodes: lessons.slice(done), next: 0 });
      meta.set(code, { source: "document", total: lessons.length, done });
    } else {
      const official = ctx.official.get(code) ?? [];
      cursors.set(code, { nodes: official, next: 0 });
      meta.set(code, { source: official.length ? "official" : "none", total: official.length, done: 0 });
    }
  }
  const to = ctx.calendar?.endsOn && ctx.calendar.endsOn > ctx.today ? ctx.calendar.endsOn : addDays(ctx.today, 300);
  const placed = distributeLessons({ slots, from: ctx.today, to, isSchoolDay: (d) => isSchoolDay(ctx.calendar, d), cursors });
  return codes.map((code) => {
    const mine = placed.filter((p) => p.slot.subjectCode === code);
    const own = slots.filter((s) => s.subjectCode === code);
    const m = meta.get(code)!;
    const cursor = cursors.get(code)!;
    return {
      subjectCode: code,
      source: m.source,
      sessionsPerWeek: own.length,
      minutesPerWeek: own.reduce((n, s) => n + minutesBetween(s.start, s.end), 0),
      lessons: m.total,
      alreadyDone: m.done,
      planned: mine.length,
      overflow: cursor.nodes.length - cursor.next,
      firstDate: mine[0]?.date ?? null,
      lastDate: mine.at(-1)?.date ?? null,
      upcoming: mine.slice(0, 4).map((p) => ({ date: p.date, start: p.slot.start, title: p.node.title })),
    };
  });
}

/* ───────────── Brouillon complet ───────────── */

export type AnalyzedDraft = EditableDraft & {
  days: number[];
  issues: Issue[];
  reconciliation: Reconciliation[];
  startHints: Record<string, number>;
  progression: SubjectPlan[];
  summary: {
    timetableFound: boolean;
    curriculumFound: boolean;
    proposal: boolean;
    subjects: { code: string; name: string; writtenNames: string[]; sessionsPerWeek: number; minutesPerWeek: number; lessons: number; sequences: number; competencies: number }[];
    totals: { subjects: number; sessionsPerWeek: number; minutesPerWeek: number; lessons: number; sequences: number; competencies: number; domains: number };
    missing: string[];
    toCheck: number;
    blocking: number;
  };
};

export function analyzeDraft(draft: EditableDraft, ctx: DraftContext): AnalyzedDraft {
  const entries = [...draft.timetable.entries].sort((a, b) => (a.weekday ?? 9) - (b.weekday ?? 9) || (a.start ?? "99").localeCompare(b.start ?? "99"));
  const lessonsEntries = entries.filter((e) => e.kind === "lesson");
  const slotSubjects = new Set(lessonsEntries.map((e) => e.subjectCode).filter((c): c is string => !!c));
  const issues: Issue[] = [...timetableIssues(entries, ctx), ...curriculumIssues(draft.curriculum, ctx, slotSubjects)];

  const reconciliation = draft.curriculum.map((s) => reconcile(s, ctx)).filter((r): r is Reconciliation => !!r);
  const name = (code: string) => ctx.subjects.find((s) => s.code === code)?.name ?? code;
  for (const r of reconciliation) {
    const label = draft.curriculum.find((s) => s.key === r.subjectKey)?.writtenName ?? name(r.subjectCode);
    if (r.official && r.gaps.length)
      issues.push({
        code: "NATIONAL_GAPS",
        severity: "info",
        message: `${label} : ${r.gaps.length} leçon(s) du programme national n'apparaissent pas dans ton document (ex. « ${r.gaps.slice(0, 2).join(" », « ")} »). Rien n'est ajouté sans toi.`,
        subjectKey: r.subjectKey,
      });
    if (!r.official) issues.push({ code: "NATIONAL_NONE", severity: "info", message: `${label} : pas encore de programme national dans PEDAGO pour cette classe, ton document fait foi.`, subjectKey: r.subjectKey });
    for (const o of r.orderIssues) issues.push({ code: "ORDER", severity: "check", message: `${label} : ${o}`, subjectKey: r.subjectKey });
  }

  const startHints: Record<string, number> = {};
  for (const s of draft.curriculum) {
    const h = startHint(s, ctx);
    if (h != null) startHints[s.key] = h;
  }

  for (const code of slotSubjects) {
    if (draft.curriculum.some((s) => !s.excluded && s.subjectCode === code)) continue;
    const official = ctx.official.get(code)?.length ?? 0;
    issues.push({
      code: official ? "USES_NATIONAL" : "NO_LESSONS",
      severity: "info",
      message: official
        ? `${name(code)} : pas de curriculum importé, la progression du programme national sera suivie.`
        : `${name(code)} : aucune leçon connue (ni importée, ni nationale) : ces créneaux resteront vides.`,
    });
  }

  if (draft.timetable.source === "proposal")
    issues.push({ code: "PROPOSAL", severity: "info", message: "Emploi du temps PROPOSÉ par PEDAGO à partir de ton curriculum : ce n'est pas ton emploi du temps officiel. Corrige-le ou importe le vrai." });
  for (const n of ctx.classifyNotes) issues.push({ code: "CLASSIFY", severity: "info", message: n });

  const progression = previewProgression(entries, draft.curriculum, ctx);
  for (const p of progression)
    if (p.overflow > 0 && p.sessionsPerWeek > 0)
      issues.push({ code: "OVERFLOW", severity: "check", message: `${name(p.subjectCode)} : ${p.overflow} leçon(s) ne tiennent pas avant la fin de l'année avec ${p.sessionsPerWeek} séance(s) par semaine.` });

  const codes = [...new Set([...slotSubjects, ...draft.curriculum.filter((s) => !s.excluded && s.subjectCode).map((s) => s.subjectCode!)])];
  const subjectsSummary = codes.map((code) => {
    const own = draft.curriculum.filter((s) => !s.excluded && s.subjectCode === code);
    const nodes = own.flatMap((s) => s.nodes);
    const slots = lessonsEntries.filter((e) => e.subjectCode === code && e.start && e.end);
    return {
      code,
      name: name(code),
      writtenNames: [...new Set([...slots.map((e) => e.label), ...own.map((s) => s.writtenName)].filter(Boolean))].slice(0, 6),
      sessionsPerWeek: slots.length,
      minutesPerWeek: slots.reduce((n, e) => n + Math.max(0, minutesBetween(e.start!, e.end!)), 0),
      lessons: nodes.filter((n) => n.kind === "lesson").length,
      sequences: nodes.filter((n) => n.kind === "unit").length,
      competencies: nodes.filter((n) => n.kind === "competency").length,
    };
  });
  const allNodes = draft.curriculum.filter((s) => !s.excluded).flatMap((s) => s.nodes);
  const missing: string[] = [];
  if (!lessonsEntries.length && draft.timetable.source !== "proposal") missing.push("Aucun emploi du temps lu.");
  if (!draft.curriculum.some((s) => !s.excluded)) missing.push("Aucun curriculum importé : le programme national sera suivi là où il existe.");
  for (const i of issues) if (i.code === "TIME_MISSING" || i.code === "SUBJECT_MISSING" || i.code === "DAY_MISSING" || i.code === "NO_LESSONS") missing.push(i.message);
  if (!codes.length) issues.push({ code: "EMPTY", severity: "block", message: "Rien à enregistrer : aucun créneau ni aucune leçon n'a été lu. Recommence l'import avec une photo plus nette." });

  const days = [1, 2, 3, 4, 5];
  if (entries.some((e) => e.weekday === 6)) days.push(6);

  return {
    ...draft,
    timetable: { ...draft.timetable, entries },
    days,
    issues,
    reconciliation,
    startHints,
    progression,
    summary: {
      timetableFound: draft.timetable.source === "document" && lessonsEntries.length > 0,
      curriculumFound: draft.curriculum.some((s) => !s.excluded && s.nodes.length > 0),
      proposal: draft.timetable.source === "proposal",
      subjects: subjectsSummary,
      totals: {
        subjects: codes.length,
        sessionsPerWeek: subjectsSummary.reduce((n, s) => n + s.sessionsPerWeek, 0),
        minutesPerWeek: subjectsSummary.reduce((n, s) => n + s.minutesPerWeek, 0),
        lessons: allNodes.filter((n) => n.kind === "lesson").length,
        sequences: allNodes.filter((n) => n.kind === "unit").length,
        competencies: allNodes.filter((n) => n.kind === "competency").length,
        domains: allNodes.filter((n) => n.kind === "domain").length,
      },
      missing: [...new Set(missing)].slice(0, 20),
      toCheck: issues.filter((i) => i.severity === "check").length,
      blocking: issues.filter((i) => i.severity === "block").length,
    },
  };
}

/** Garde seulement la partie modifiable d'un brouillon analysé (ce qui est stocké). */
export function editablePart(d: EditableDraft): EditableDraft {
  return { timetable: d.timetable, curriculum: d.curriculum, notes: d.notes ?? [] };
}
