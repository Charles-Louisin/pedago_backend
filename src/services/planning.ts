import { Types } from "mongoose";
import { AcademicCalendar, CatchUpItem, CurriculumNode, LessonInstance, Timetable } from "../models/index.js";
import { addDays, eachDay, weekday } from "../utils/dates.js";

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

  const subjects = [...new Set(timetable.slots.map((s) => s.subjectCode))];
  const existing = await LessonInstance.find({ teacherId, classLevel, date: { $gte: from, $lte: to } })
    .select("date start subjectCode")
    .lean();
  const taken = new Set(existing.map((l) => `${l.date}|${l.start}`));

  const cursors = new Map<string, { nodes: Awaited<ReturnType<typeof lessonNodes>>; next: number }>();
  for (const subjectCode of subjects) {
    const nodes = await lessonNodes(classLevel, subjectCode);
    // Les leçons déjà attribuées (hors annulées) ne sont pas redistribuées.
    const planned = await LessonInstance.distinct("nodeId", {
      teacherId,
      classLevel,
      subjectCode,
      origin: "plan",
      status: { $ne: "cancelled" },
    });
    const plannedSet = new Set(planned.map(String));
    const firstFree = nodes.findIndex((n) => !plannedSet.has(String(n._id)));
    cursors.set(subjectCode, { nodes, next: firstFree === -1 ? nodes.length : firstFree });
  }

  const docs: Record<string, unknown>[] = [];
  for (const date of eachDay(from, to)) {
    if (!isSchoolDay(cal, date)) continue;
    const wd = weekday(date);
    const slots = timetable.slots.filter((s) => s.weekday === wd).sort((a, b) => a.start.localeCompare(b.start));
    for (const slot of slots) {
      if (taken.has(`${date}|${slot.start}`)) continue;
      const cursor = cursors.get(slot.subjectCode)!;
      const node = cursor.nodes[cursor.next];
      if (!node) continue;
      cursor.next += 1;
      docs.push({
        teacherId,
        classLevel,
        subjectCode: slot.subjectCode,
        nodeId: node._id,
        date,
        start: slot.start,
        end: slot.end,
        slotId: slot._id,
        origin: "plan",
      });
    }
  }
  if (docs.length) await LessonInstance.insertMany(docs, { ordered: false });
  return docs.length;
}

type Option =
  | { kind: "insert_next_slot"; date: string; start: string; lessonId: string; shifted: number; label: string }
  | { kind: "replace_low_priority"; date: string; start: string; lessonId: string; replacedTitle: string; label: string }
  | { kind: "drop"; label: string };

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
    // insert_next_slot : on fait glisser les leçons suivantes d'un créneau.
    const chain = await LessonInstance.find({
      teacherId,
      classLevel: target.classLevel,
      subjectCode: target.subjectCode,
      status: "planned",
      $or: [{ date: { $gt: target.date } }, { date: target.date, start: { $gte: target.start } }],
    }).sort({ date: 1, start: 1 });
    let carry = item.nodeId as Types.ObjectId;
    for (const lesson of chain) {
      const current = lesson.nodeId as Types.ObjectId;
      lesson.nodeId = carry;
      lesson.rev += 1;
      if (String(carry) === String(item.nodeId)) {
        lesson.origin = "catchup";
        lesson.catchUpOf = item.lessonId;
        lesson.remainingObjectives = item.remainingObjectives;
      }
      await lesson.save();
      carry = current;
    }
    // La dernière leçon déplacée sera replacée par ensurePlan au prochain créneau libre (curseur).
  }
  item.status = "scheduled";
  item.scheduledLessonId = target._id;
  await item.save();
  return { status: "scheduled" as const, lessonId: String(target._id) };
}
