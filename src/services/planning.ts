import { Types } from "mongoose";
import { AcademicCalendar, CatchUpItem, CurriculumNode, LessonInstance, Timetable, TIMETABLE_HISTORY_MAX } from "../models/index.js";
import { addDays, eachDay, weekday } from "../utils/dates.js";
import { lessonsFor } from "./curriculum.js";

type Calendar = { startsOn: string; endsOn: string; breaks: { startsOn: string; endsOn: string }[] };

export function isSchoolDay(cal: Calendar | null, date: string) {
  if (!cal) return weekday(date) <= 5;
  if (date < cal.startsOn || date > cal.endsOn) return false;
  return !cal.breaks.some((b) => date >= b.startsOn && date <= b.endsOn);
}

export async function getCalendar(schoolYear: string) {
  return AcademicCalendar.findOne({ schoolYear }).lean<Calendar & { schoolYear: string }>();
}

/** Leçons du référentiel d'une classe/matière, dans l'ordre de la progression type. */
export async function lessonNodes(classLevel: string, subjectCode: string) {
  return CurriculumNode.find({ classLevel, subjectCode, kind: "lesson", status: { $ne: "retired" } })
    .sort({ order: 1 })
    .select("_id title objectives durationMin prerequisites priority term order")
    .lean();
}

export type PlanSlot = { _id?: unknown; weekday: number; start: string; end: string; subjectCode: string };

/**
 * Cœur déterministe de la planification, sans base de données : jour après jour (jours de classe seulement),
 * chaque créneau d'une matière reçoit la leçon suivante de sa file. Les curseurs avancent sur place.
 * Utilisé par `ensurePlan` (séances réelles) et par l'aperçu de progression d'un import (rien n'est écrit).
 */
export function distributeLessons<N>(o: {
  slots: PlanSlot[];
  from: string;
  to: string;
  isSchoolDay: (date: string) => boolean;
  cursors: Map<string, { nodes: N[]; next: number }>;
  /** Créneaux déjà occupés (« date|début ») : laissés tels quels. */
  taken?: Set<string>;
}) {
  const out: { date: string; slot: PlanSlot; node: N }[] = [];
  const byDay = new Map<number, PlanSlot[]>();
  for (const s of [...o.slots].sort((a, b) => a.start.localeCompare(b.start))) byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s]);
  for (const date of eachDay(o.from, o.to)) {
    if (!o.isSchoolDay(date)) continue;
    for (const slot of byDay.get(weekday(date)) ?? []) {
      if (o.taken?.has(`${date}|${slot.start}`)) continue;
      const cursor = o.cursors.get(slot.subjectCode);
      const node = cursor?.nodes[cursor.next];
      if (!cursor || !node) continue;
      cursor.next += 1;
      out.push({ date, slot, node });
    }
  }
  return out;
}

/**
 * Génère (de façon idempotente) les séances prévues entre deux dates à partir de l'emploi du temps.
 * Algorithme déterministe, sans IA : chaque créneau d'une matière reçoit la leçon suivante non encore planifiée.
 */
export async function ensurePlan(teacherId: string, classLevel: string, schoolYear: string, from: string, to: string) {
  const [timetable, cal] = await Promise.all([
    Timetable.findOne({ teacherId, classLevel, schoolYear }).lean(),
    getCalendar(schoolYear),
  ]);
  if (!timetable || timetable.slots.length === 0) return 0;
  // Un nouvel emploi du temps ne crée pas de séances dans le passé : la progression commence le jour où il est créé
  // (sinon un enseignant inscrit aujourd'hui aurait déjà une semaine de « retard » fictif).
  const createdOn = timetable.createdAt ? new Date(timetable.createdAt).toISOString().slice(0, 10) : from;
  if (createdOn > from) from = createdOn;
  if (from > to) return 0;
  // Déjà planifié sur cette plage : aucun calcul (cas le plus fréquent, à chaque ouverture de l'app).
  if (timetable.plannedFrom && timetable.plannedThrough && timetable.plannedFrom <= from && to <= timetable.plannedThrough) return 0;

  const subjects = [...new Set(timetable.slots.map((s) => s.subjectCode))];
  // 3 requêtes au total, quel que soit le nombre de matières.
  const [existing, bySubject, plannedRows] = await Promise.all([
    LessonInstance.find({ teacherId, classLevel, date: { $gte: from, $lte: to } }).select("date start").lean(),
    // Progression de l'enseignant si elle existe pour la matière, sinon programme officiel.
    lessonsFor(teacherId, classLevel, subjects),
    // Les leçons déjà attribuées (hors annulées) ne sont pas redistribuées.
    LessonInstance.find({ teacherId, classLevel, origin: "plan", status: { $ne: "cancelled" } }).select("nodeId -_id").lean(),
  ]);
  const taken = new Set(existing.map((l) => `${l.date}|${l.start}`));
  const plannedSet = new Set(plannedRows.map((r) => String(r.nodeId)));

  const cursors = new Map<string, { nodes: { _id: unknown }[]; next: number }>();
  for (const subjectCode of subjects) {
    const nodes = (bySubject.get(subjectCode)?.nodes ?? []).filter((n) => !(n as { alreadyTaught?: boolean }).alreadyTaught);
    const firstFree = nodes.findIndex((n) => !plannedSet.has(String(n._id)));
    cursors.set(subjectCode, { nodes, next: firstFree === -1 ? nodes.length : firstFree });
  }

  const docs = distributeLessons({ slots: timetable.slots, from, to, isSchoolDay: (d) => isSchoolDay(cal, d), cursors, taken }).map(({ date, slot, node }) => ({
    teacherId,
    classLevel,
    subjectCode: slot.subjectCode,
    nodeId: node._id,
    date,
    start: slot.start,
    end: slot.end,
    slotId: slot._id,
    origin: "plan",
  }));
  if (docs.length) await LessonInstance.insertMany(docs, { ordered: false });
  const plannedFrom = timetable.plannedFrom && timetable.plannedFrom < from ? timetable.plannedFrom : from;
  const plannedThrough = timetable.plannedThrough && timetable.plannedThrough > to ? timetable.plannedThrough : to;
  // Le repère n'est étendu que si la plage est contiguë à celle déjà planifiée.
  const contiguous = !timetable.plannedThrough || (from <= addDays(timetable.plannedThrough, 1) && to >= addDays(timetable.plannedFrom ?? from, -1));
  await Timetable.updateOne(
    { _id: timetable._id },
    contiguous ? { plannedFrom, plannedThrough } : { plannedFrom: from, plannedThrough: to }
  );
  return docs.length;
}

export type TimetableInput = {
  slots: { weekday: number; start: string; end: string; subjectCode: string; room?: string | null; label?: string | null }[];
  extras?: { weekday: number; start: string; end: string; kind: "break" | "special"; label: string }[];
  source: "manual" | "import" | "proposal";
  importId?: string;
};

/**
 * Enregistre une NOUVELLE VERSION de l'emploi du temps : l'état précédent part dans l'historique
 * (20 versions gardées), le repère de planification est effacé et les séances futures encore « prévues »
 * sont supprimées pour être recalculées. Le passé (fait, partiel, manqué) n'est jamais touché.
 */
export async function saveTimetableVersion(teacherId: string, classLevel: string, schoolYear: string, input: TimetableInput, today: string) {
  const current = await Timetable.findOne({ teacherId, classLevel, schoolYear }).lean();
  const strip = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "")) as T;
  const snapshot = current
    ? {
        version: current.version,
        source: current.source ?? "manual",
        importId: current.importId,
        slots: current.slots.map((s) => strip({ weekday: s.weekday, start: s.start, end: s.end, subjectCode: s.subjectCode, room: s.room, label: s.label })),
        extras: current.extras ?? [],
        savedAt: current.updatedAt ?? new Date(),
      }
    : null;
  const tt = await Timetable.findOneAndUpdate(
    { teacherId, classLevel, schoolYear },
    {
      slots: input.slots.map(strip),
      extras: input.extras ?? [],
      source: input.source,
      ...(input.importId ? { importId: input.importId } : {}),
      $unset: { plannedFrom: 1, plannedThrough: 1, ...(input.importId ? {} : { importId: 1 }) },
      $inc: { version: 1 },
      ...(snapshot ? { $push: { history: { $each: [snapshot], $slice: -TIMETABLE_HISTORY_MAX } } } : {}),
    },
    { upsert: true, new: true, runValidators: true }
  ).lean();
  await LessonInstance.deleteMany({ teacherId, classLevel, date: { $gt: today }, status: "planned", origin: "plan" });
  return tt!;
}

type Option =
  | { kind: "insert_next_slot"; date: string; start: string; lessonId: string; shifted: number; label: string }
  | { kind: "replace_low_priority"; date: string; start: string; lessonId: string; replacedTitle: string; label: string }
  | { kind: "split_two_slots"; date: string; start: string; lessonId: string; secondDate: string; label: string }
  | { kind: "drop"; label: string };

/** Objectifs restant à traiter : ceux notés au bilan partiel, ou tous si la leçon n'a pas été faite. */
async function remainingOf(item: { nodeId: unknown; remainingObjectives?: number[] | null }) {
  if (item.remainingObjectives?.length) return [...item.remainingObjectives];
  const node = await CurriculumNode.findById(item.nodeId, { objectives: 1 }).lean();
  return (node?.objectives ?? []).map((_, i) => i);
}

/**
 * Moteur de rattrapage : propose des options, l'enseignant confirme toujours.
 * - insérer au prochain créneau de la matière (les leçons suivantes glissent d'un créneau),
 * - remplacer une séance de faible priorité (révision) dans les 2 semaines si les prérequis le permettent,
 * - ne pas rattraper (l'élément reste tracé comme abandonné).
 */
export async function proposeCatchUp(teacherId: string, itemId: string, today: string) {
  const item = await CatchUpItem.findOne({ _id: itemId, teacherId }).lean();
  if (!item) return null;
  const future = await LessonInstance.find({
    teacherId,
    classLevel: item.classLevel,
    subjectCode: item.subjectCode,
    date: { $gt: today },
    status: "planned",
  })
    .sort({ date: 1, start: 1 })
    .limit(40)
    .populate<{ nodeId: { _id: Types.ObjectId; title: string; priority: number; prerequisites: Types.ObjectId[] } }>(
      "nodeId",
      "title priority prerequisites"
    )
    .lean();

  const options: Option[] = [];
  const next = future[0];
  if (next) {
    options.push({
      kind: "insert_next_slot",
      date: next.date,
      start: next.start ?? "",
      lessonId: String(next._id),
      shifted: future.length,
      label: `Placer au prochain cours (${next.date} à ${next.start}) et décaler la suite d'une séance`,
    });
  }
  // Leçon trop longue pour un seul créneau : la moitié des objectifs à chacun des deux prochains cours.
  const second = future[1];
  if (next && second && (await remainingOf(item)).length >= 2) {
    options.push({
      kind: "split_two_slots",
      date: next.date,
      start: next.start ?? "",
      lessonId: String(next._id),
      secondDate: second.date,
      label: `Répartir sur deux séances (${next.date} et ${second.date}) et décaler la suite de deux séances`,
    });
  }
  const horizon = addDays(today, 14);
  const low = future.find(
    (l) =>
      l.date <= horizon &&
      l.nodeId?.priority === 3 &&
      // la séance remplacée ne doit pas dépendre de la leçon à rattraper (elle serait déplacée après)
      !l.nodeId.prerequisites?.some((p) => String(p) === String(item.nodeId))
  );
  if (low) {
    options.push({
      kind: "replace_low_priority",
      date: low.date,
      start: low.start ?? "",
      lessonId: String(low._id),
      replacedTitle: low.nodeId.title,
      label: `Remplacer « ${low.nodeId.title} » (${low.date}), séance de faible priorité`,
    });
  }
  options.push({ kind: "drop", label: "Ne pas rattraper cette leçon (elle restera visible dans le cahier de textes)" });
  return { item, options };
}

export async function applyCatchUp(teacherId: string, itemId: string, option: Option["kind"], targetLessonId?: string) {
  const item = await CatchUpItem.findOne({ _id: itemId, teacherId, status: "open" });
  if (!item) return null;

  if (option === "drop") {
    item.status = "dropped";
    await item.save();
    return { status: "dropped" as const };
  }

  const target = await LessonInstance.findOne({ _id: targetLessonId, teacherId, status: "planned" });
  if (!target) return null;

  if (option === "replace_low_priority") {
    // La séance remplacée est reportée dans la file de rattrapage pour ne jamais disparaître.
    const replacedNode = target.nodeId;
    target.nodeId = item.nodeId;
    target.origin = "catchup";
    target.catchUpOf = item.lessonId;
    target.remainingObjectives = item.remainingObjectives;
    target.rev += 1;
    await target.save();
    await LessonInstance.create({
      teacherId,
      classLevel: target.classLevel,
      subjectCode: target.subjectCode,
      nodeId: replacedNode,
      date: target.date,
      start: target.start,
      end: target.end,
      status: "rescheduled",
      origin: "manual",
    }).then((placeholder) =>
      CatchUpItem.create({
        teacherId,
        lessonId: placeholder._id,
        nodeId: replacedNode,
        classLevel: target.classLevel,
        subjectCode: target.subjectCode,
        reason: "missed",
      })
    );
  } else {
    // insert_next_slot : la leçon prend le prochain créneau, les suivantes glissent d'un créneau.
    // split_two_slots : elle prend les deux prochains (objectifs partagés), la suite glisse de deux.
    const chain = await LessonInstance.find({
      teacherId,
      classLevel: target.classLevel,
      subjectCode: target.subjectCode,
      status: "planned",
      $or: [{ date: { $gt: target.date } }, { date: target.date, start: { $gte: target.start } }],
    }).sort({ date: 1, start: 1 });
    let inserts: number[][];
    if (option === "split_two_slots") {
      const left = await remainingOf(item);
      if (left.length < 2 || chain.length < 2) return null;
      const half = Math.ceil(left.length / 2);
      inserts = [left.slice(0, half), left.slice(half)];
    } else {
      inserts = [item.remainingObjectives ?? []];
    }
    // File d'attente : d'abord la (ou les) partie(s) à rattraper, puis chaque leçon déplacée.
    const queue: { nodeId: Types.ObjectId; catchUp?: number[]; origin?: string; remaining?: number[] }[] = inserts.map((objs) => ({
      nodeId: item.nodeId as Types.ObjectId,
      catchUp: objs,
    }));
    for (const lesson of chain) {
      queue.push({ nodeId: lesson.nodeId as Types.ObjectId, origin: lesson.origin, remaining: lesson.remainingObjectives ?? [] });
      const next = queue.shift()!;
      lesson.nodeId = next.nodeId;
      lesson.rev += 1;
      if (next.catchUp) {
        lesson.origin = "catchup";
        lesson.catchUpOf = item.lessonId;
        lesson.remainingObjectives = next.catchUp;
      } else {
        lesson.origin = (next.origin as typeof lesson.origin) ?? "plan";
        lesson.remainingObjectives = next.remaining ?? [];
      }
      await lesson.save();
    }
    // Les leçons poussées en fin de chaîne seront replacées par ensurePlan au prochain créneau libre (curseur).
  }
  item.status = "scheduled";
  item.scheduledLessonId = target._id;
  await item.save();
  // La leçon repoussée en fin de chaîne doit être replacée : on invalide le repère de planification.
  await Timetable.updateMany({ teacherId, classLevel: target.classLevel }, { $unset: { plannedFrom: 1, plannedThrough: 1 } });
  return { status: "scheduled" as const, lessonId: String(target._id) };
}
