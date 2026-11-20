import { Router } from "express";
import multer from "multer";
import { analyzeImport, IMPORT_MAX_BYTES } from "../services/imports.js";
import { z } from "zod";
import { exportAccount } from "../services/account.js";
import {
  ALL_CLASS_LEVELS,
  CatchUpItem,
  CLASS_LEVELS,
  CurriculumNode,
  LessonInstance,
  ProgressEvent,
  Resource,
  Subject,
  TeacherProfile,
  TeacherPrep,
  TeacherUpload,
  Timetable,
  User,
} from "../models/index.js";
import { requireAuth, requireVerifiedEmail, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah, badRequest, notFound } from "../utils/http-error.js";
import { addDays, isLocalDate, minutesBetween } from "../utils/dates.js";
import { applyCatchUp, ensurePlan, proposeCatchUp } from "../services/planning.js";
import { lessonsFor, parseProgression, resetTeacherCurriculum, saveTeacherCurriculum } from "../services/curriculum.js";
import { buildLessonDocument, composeLessonDoc, previewOf, type ComposeOptions } from "../services/exports.js";
import { prepLayoutSchema, type PrepLayout } from "../services/layout.js";
import { toMe } from "./auth.js";

export const teacherRouter = Router();
teacherRouter.use(requireAuth, requireVerifiedEmail);

const uid = (req: unknown) => (req as AuthedRequest).userId;
const localDate = z.string().refine(isLocalDate, "Date attendue au format AAAA-MM-JJ");

async function profileOf(userId: string) {
  const profile = await TeacherProfile.findOne({ userId }).lean();
  if (!profile) throw badRequest("PROFILE_REQUIRED", "Complète d'abord ton profil pédagogique");
  return profile;
}

function assertTeaches(profile: { assignments: { classLevel: string }[] }, classLevel: string) {
  if (!profile.assignments.some((a) => a.classLevel === classLevel)) {
    throw badRequest("CLASS_NOT_ASSIGNED", "Cette classe ne fait pas partie de ton profil");
  }
}

/* ───────────── Profil ───────────── */

/** Export complet de mes données (droit d'accès et de portabilité). */
teacherRouter.get(
  "/me/export",
  ah(async (req, res) => {
    const data = await exportAccount(uid(req));
    res.setHeader("Content-Disposition", `attachment; filename="pedago-mes-donnees-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  })
);

teacherRouter.get(
  "/me",
  ah(async (req, res) => {
    const [user, profile] = await Promise.all([User.findById(uid(req)).lean(), TeacherProfile.findOne({ userId: uid(req) }).lean()]);
    if (!user) throw notFound();
    res.json(toMe(user, profile));
  })
);

const profileSchema = z
  .object({
    subsystem: z.enum(["francophone", "anglophone"]),
    teachingLanguage: z.enum(["fr", "en"]),
    schoolName: z.string().trim().max(160).nullish().transform((v) => v || undefined),
    region: z.string().trim().max(80).nullish().transform((v) => v || undefined),
    division: z.string().trim().max(80).nullish().transform((v) => v || undefined),
    schoolYear: z.string().regex(/^\d{4}-\d{4}$/),
    assignments: z
      .array(z.object({ classLevel: z.enum(ALL_CLASS_LEVELS), subjects: z.array(z.string().max(40)).min(1).max(20) }))
      .min(1)
      .max(6),
    preferences: z
      .object({
        difficulty: z.enum(["easy", "standard", "advanced"]).default("standard"),
        illustrationLevel: z.enum(["simple", "standard", "detailed"]).default("simple"),
        wifiOnlyDownloads: z.boolean().default(false),
        lowInkExports: z.boolean().default(true),
      })
      .partial()
      .optional(),
  })
  .refine((p) => p.assignments.every((a) => (CLASS_LEVELS[p.subsystem] as readonly string[]).includes(a.classLevel)), {
    message: "Les classes doivent appartenir au sous-système choisi",
  });

teacherRouter.put(
  "/me/profile",
  validate(profileSchema),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof profileSchema>;
    const existing = await TeacherProfile.findOne({ userId: uid(req) });
    // Valeurs par défaut explicites, puis préférences existantes, puis nouvelles (fusion sur des objets simples).
    const current = (existing?.toObject().preferences ?? {}) as Record<string, unknown>;
    const preferences = { difficulty: "standard", illustrationLevel: "simple", wifiOnlyDownloads: false, lowInkExports: true, ...current, ...(body.preferences ?? {}) };
    const profile = await TeacherProfile.findOneAndUpdate(
      { userId: uid(req) },
      { ...body, preferences, $setOnInsert: { userId: uid(req) }, onboardingCompletedAt: existing?.onboardingCompletedAt ?? new Date() },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    const user = await User.findById(uid(req)).lean();
    res.json(toMe(user, profile));
  })
);

/* ───────────── Référentiel (lecture) ───────────── */

teacherRouter.get(
  "/subjects",
  validate(z.object({ subsystem: z.enum(["francophone", "anglophone"]) }), "query"),
  ah(async (req, res) => {
    const subjects = await Subject.find({ subsystem: req.query.subsystem }).sort({ order: 1 }).select("-__v").lean();
    res.set("Cache-Control", "public, max-age=3600").json(subjects);
  })
);

/* ───────────── Emploi du temps ───────────── */

const timetableSchema = z.object({
  classLevel: z.enum(ALL_CLASS_LEVELS),
  slots: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(6),
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
        subjectCode: z.string().max(40),
      })
    )
    .max(80)
    .refine((slots) => slots.every((s) => minutesBetween(s.start, s.end) > 0), "Chaque créneau doit finir après son début")
    .refine((slots) => {
      for (const a of slots)
        for (const b of slots)
          if (a !== b && a.weekday === b.weekday && a.start < b.end && b.start < a.end) return false;
      return true;
    }, "Deux créneaux se chevauchent"),
});

teacherRouter.get(
  "/timetable/:classLevel",
  ah(async (req, res) => {
    const profile = await profileOf(uid(req));
    const tt = await Timetable.findOne({ teacherId: uid(req), classLevel: req.params.classLevel, schoolYear: profile.schoolYear }).lean();
    res.json(tt ?? { classLevel: req.params.classLevel, slots: [], version: 0 });
  })
);

teacherRouter.put(
  "/timetable",
  validate(timetableSchema),
  ah(async (req, res) => {
    const profile = await profileOf(uid(req));
    const { classLevel, slots } = req.body as z.infer<typeof timetableSchema>;
    assertTeaches(profile, classLevel);
    const tt = await Timetable.findOneAndUpdate(
      { teacherId: uid(req), classLevel, schoolYear: profile.schoolYear },
      { slots, $inc: { version: 1 }, $unset: { plannedFrom: 1, plannedThrough: 1 } },
      { upsert: true, new: true }
    ).lean();
    // Les séances futures encore « prévues » sont recalculées avec le nouvel emploi du temps.
    const today = typeof req.query.today === "string" && isLocalDate(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
    await LessonInstance.deleteMany({ teacherId: uid(req), classLevel, date: { $gt: today }, status: "planned", origin: "plan" });
    res.json(tt);
  })
);

/* ───────────── Programme du jour / plage ───────────── */

async function resourcesFor(nodeIds: unknown[], prefs: { difficulty?: string; illustrationLevel?: string }) {
  const fields = "_id nodeId type title difficulty illustrationLevel contentVersion assets.pdf.sizeBytes assets.docx.sizeBytes";
  // En parallèle : ressources des leçons elles-mêmes, et leçons personnelles rattachées au programme officiel.
  const [own, direct] = await Promise.all([
    CurriculumNode.find({ _id: { $in: nodeIds }, matchedNodeId: { $ne: null } }).select("_id matchedNodeId").lean(),
    Resource.find({ nodeId: { $in: nodeIds }, status: "PUBLISHED" }).select(fields).lean(),
  ]);
  const alias = new Map(own.map((n) => [String(n.matchedNodeId), String(n._id)]));
  // Seulement si l'enseignant a sa propre progression : ressources des leçons officielles correspondantes.
  const matched = own.length ? await Resource.find({ nodeId: { $in: own.map((n) => n.matchedNodeId) }, status: "PUBLISHED" }).select(fields).lean() : [];
  const resources = [...direct, ...matched];
  const byNode = new Map<string, typeof resources>();
  for (const r of resources) {
    const key = alias.get(String(r.nodeId)) ?? String(r.nodeId);
    const list = byNode.get(key) ?? [];
    list.push(r);
    byNode.set(key, list);
  }
  // Pour chaque type, on garde la variante la plus proche des préférences de l'enseignant.
  const score = (r: (typeof resources)[number]) =>
    (r.difficulty === prefs.difficulty ? 2 : r.difficulty === "standard" ? 1 : 0) +
    (r.illustrationLevel === prefs.illustrationLevel ? 1 : 0);
  const out = new Map<string, unknown[]>();
  for (const [node, list] of byNode) {
    const best = new Map<string, (typeof resources)[number]>();
    for (const r of list) {
      const cur = best.get(r.type);
      if (!cur || score(r) > score(cur)) best.set(r.type, r);
    }
    out.set(
      node,
      [...best.values()].map((r) => ({
        id: String(r._id),
        type: r.type,
        title: r.title,
        difficulty: r.difficulty,
        illustrationLevel: r.illustrationLevel,
        contentVersion: r.contentVersion,
        pdfBytes: r.assets?.pdf?.sizeBytes ?? null,
        docxBytes: r.assets?.docx?.sizeBytes ?? null,
      }))
    );
  }
  return out;
}

const rangeSchema = z.object({ from: localDate, to: localDate, classLevel: z.enum(ALL_CLASS_LEVELS).optional() });

teacherRouter.get(
  "/planning",
  validate(rangeSchema, "query"),
  ah(async (req, res) => {
    const { from, to, classLevel } = req.query as unknown as z.infer<typeof rangeSchema>;
    if (from > to || addDays(from, 120) < to) throw badRequest("BAD_RANGE", "Plage de dates invalide (120 jours maximum)");
    const profile = await profileOf(uid(req));
    const classes = classLevel ? [classLevel] : profile.assignments.map((a) => a.classLevel);
    for (const c of classes) {
      assertTeaches(profile, c);
      await ensurePlan(uid(req), c, profile.schoolYear, from, to);
    }
    const lessons = await LessonInstance.find({ teacherId: uid(req), classLevel: { $in: classes }, date: { $gte: from, $lte: to } })
      .sort({ date: 1, start: 1 })
      .lean();
    const nodeIds = [...new Set(lessons.map((l) => String(l.nodeId)))];
    const [nodes, resources] = await Promise.all([
      CurriculumNode.find({ _id: { $in: nodeIds } }).select("title objectives durationMin subjectCode term").lean(),
      resourcesFor(nodeIds, profile.preferences ?? {}),
    ]);
    const nodeMap = new Map(nodes.map((n) => [String(n._id), n]));
    res.json({
      from,
      to,
      lessons: lessons.map((l) => {
        const node = nodeMap.get(String(l.nodeId));
        return {
          id: String(l._id),
          date: l.date,
          start: l.start,
          end: l.end,
          classLevel: l.classLevel,
          subjectCode: l.subjectCode,
          status: l.status,
          origin: l.origin,
          rev: l.rev,
          remainingObjectives: l.remainingObjectives ?? [],
          node: node
            ? { id: String(node._id), title: node.title, objectives: node.objectives, durationMin: node.durationMin, term: node.term }
            : null,
          resources: resources.get(String(l.nodeId)) ?? [],
        };
      }),
    });
  })
);

/* ───────────── Synchronisation hors connexion (idempotente) ───────────── */

const eventSchema = z.object({
  opId: z.string().min(8).max(64),
  lessonId: z.string().regex(/^[a-f\d]{24}$/i),
  status: z.enum(["done", "partial", "missed"]),
  objectivesDone: z.array(z.number().int().min(0).max(50)).max(50).optional(),
  durationMin: z.number().int().min(0).max(600).optional(),
  difficulties: z.string().max(1000).optional(),
  toRedo: z.string().max(1000).optional(),
  note: z.string().max(2000).optional(),
  recordedAt: z.string().datetime(),
});

teacherRouter.post(
  "/sync/events",
  validate(z.object({ events: z.array(eventSchema).min(1).max(200) })),
  ah(async (req, res) => {
    const teacherId = uid(req);
    const events = (req.body.events as z.infer<typeof eventSchema>[]).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    // Autorisation par objet : seules les séances de l'enseignant sont acceptées.
    const owned = await LessonInstance.find({ _id: { $in: events.map((e) => e.lessonId) }, teacherId })
      .populate<{ nodeId: { _id: unknown; objectives: string[] } }>("nodeId", "objectives")
      .lean();
    const lessons = new Map(owned.map((l) => [String(l._id), l]));
    const acks: { opId: string; status: "applied" | "duplicate" | "rejected"; reason?: string }[] = [];

    const valid = events.filter((e) => {
      if (lessons.has(e.lessonId)) return true;
      acks.push({ opId: e.opId, status: "rejected", reason: "LESSON_NOT_FOUND" });
      return false;
    });

    // 1. Doublons : opId déjà reçu précédemment, ou répété dans ce même lot (seule la 1re occurrence compte).
    const known = new Set(
      (await ProgressEvent.find({ teacherId, opId: { $in: valid.map((e) => e.opId) } }).select("opId -_id").lean()).map((e) => e.opId)
    );
    const duplicates = new Set<number>();
    const fresh: typeof valid = [];
    const seen = new Set<string>();
    valid.forEach((e, i) => {
      if (known.has(e.opId) || seen.has(e.opId)) duplicates.add(i);
      else {
        seen.add(e.opId);
        fresh.push(e);
      }
    });
    if (fresh.length) {
      try {
        await ProgressEvent.insertMany(fresh.map((e) => ({ ...e, teacherId, recordedAt: new Date(e.recordedAt) })), { ordered: false });
      } catch (err: any) {
        // Course entre deux envois simultanés : la contrainte d'unicité garantit qu'aucun événement n'est compté deux fois.
        if (!(err?.writeErrors ?? []).every((we: any) => (we.code ?? we.err?.code) === 11000)) throw err;
      }
    }
    valid.forEach((e, i) => acks.push({ opId: e.opId, status: duplicates.has(i) ? "duplicate" : "applied" }));

    // 2. Pour chaque séance touchée, l'état reflète l'événement le plus récent (une seule requête).
    const touched = [...new Set(fresh.map((e) => e.lessonId))];
    if (touched.length) {
      const latest = await ProgressEvent.aggregate<{ _id: unknown; ev: { status: "done" | "partial" | "missed"; objectivesDone?: number[] } }>([
        { $match: { teacherId: owned[0].teacherId, lessonId: { $in: touched.map((id) => owned.find((l) => String(l._id) === id)!._id) } } },
        { $sort: { recordedAt: -1 } },
        { $group: { _id: "$lessonId", ev: { $first: "$$ROOT" } } },
      ]);
      const lessonOps: any[] = [];
      const catchOps: any[] = [];
      for (const { _id, ev } of latest) {
        const lesson = lessons.get(String(_id))!;
        const total = lesson.nodeId?.objectives?.length ?? 0;
        const all = [...Array(total).keys()];
        const remaining = ev.status === "partial" ? all.filter((i) => !(ev.objectivesDone ?? []).includes(i)) : ev.status === "missed" ? all : [];
        lessonOps.push({ updateOne: { filter: { _id, teacherId }, update: { status: ev.status, remainingObjectives: remaining, $inc: { rev: 1 } } } });
        if (ev.status === "done") {
          catchOps.push({ updateOne: { filter: { teacherId, lessonId: _id, status: "open" }, update: { status: "resolved" } } });
          // Une séance de rattrapage faite clôt l'élément d'origine.
          if (lesson.catchUpOf) catchOps.push({ updateOne: { filter: { teacherId, lessonId: lesson.catchUpOf }, update: { status: "resolved" } } });
        } else {
          catchOps.push({
            updateOne: {
              filter: { teacherId, lessonId: _id },
              update: {
                $set: { reason: ev.status, remainingObjectives: remaining, status: "open" },
                $setOnInsert: { nodeId: lesson.nodeId?._id, classLevel: lesson.classLevel, subjectCode: lesson.subjectCode },
              },
              upsert: true,
            },
          });
        }
      }
      await Promise.all([
        lessonOps.length ? LessonInstance.bulkWrite(lessonOps, { ordered: false }) : null,
        catchOps.length ? CatchUpItem.bulkWrite(catchOps, { ordered: false }) : null,
      ]);
    }
    res.json({ acks, serverTime: new Date().toISOString() });
  })
);

/* ───────────── Rattrapage ───────────── */

teacherRouter.get(
  "/catchup",
  ah(async (req, res) => {
    const items = await CatchUpItem.find({ teacherId: uid(req), status: "open" })
      .sort({ createdAt: 1 })
      .populate<{ nodeId: { title: string; objectives: string[] } }>("nodeId", "title objectives")
      .populate<{ lessonId: { date: string; start: string } }>("lessonId", "date start")
      .lean();
    res.json(
      items.map((i) => ({
        id: String(i._id),
        reason: i.reason,
        classLevel: i.classLevel,
        subjectCode: i.subjectCode,
        title: i.nodeId?.title,
        objectives: i.nodeId?.objectives ?? [],
        remainingObjectives: i.remainingObjectives ?? [],
        originalDate: i.lessonId?.date,
      }))
    );
  })
);

teacherRouter.get(
  "/catchup/:id/options",
  validate(z.object({ today: localDate }), "query"),
  ah(async (req, res) => {
    const out = await proposeCatchUp(uid(req), String(req.params.id), String(req.query.today));
    if (!out) throw notFound("Élément de rattrapage introuvable");
    res.json(out.options);
  })
);

teacherRouter.post(
  "/catchup/:id/apply",
  validate(
    z.object({ kind: z.enum(["insert_next_slot", "split_two_slots", "replace_low_priority", "drop"]), lessonId: z.string().regex(/^[a-f\d]{24}$/i).optional() })
  ),
  ah(async (req, res) => {
    const out = await applyCatchUp(uid(req), String(req.params.id), req.body.kind, req.body.lessonId);
    if (!out) throw badRequest("CATCHUP_NOT_APPLICABLE", "Cette proposition n'est plus valable, actualise la liste");
    res.json(out);
  })
);

/* ───────────── Progression annuelle & cahier de textes ───────────── */

teacherRouter.get(
  "/progress/coverage",
  validate(z.object({ classLevel: z.enum(ALL_CLASS_LEVELS), today: localDate }), "query"),
  ah(async (req, res) => {
    const { classLevel, today } = req.query as { classLevel: string; today: string };
    const profile = await profileOf(uid(req));
    assertTeaches(profile, classLevel);
    const subjects = profile.assignments.find((a) => a.classLevel === classLevel)?.subjects ?? [];
    const [bySubject, lessons] = await Promise.all([
      lessonsFor(uid(req), classLevel, subjects),
      LessonInstance.find({ teacherId: uid(req), classLevel }).select("nodeId status date subjectCode").lean(),
    ]);
    const nodes = [...bySubject.values()].flatMap((v) => v.nodes);
    const statusByNode = new Map<string, string>();
    for (const n of nodes) if ((n as { alreadyTaught?: boolean }).alreadyTaught) statusByNode.set(String(n._id), "done");
    const lateNodes = new Set<string>();
    for (const l of lessons) {
      const k = String(l.nodeId);
      const prev = statusByNode.get(k);
      if (l.status === "done" || (l.status === "partial" && prev !== "done") || !prev) statusByNode.set(k, l.status);
      if (l.date < today && l.status === "planned") lateNodes.add(k);
    }
    const summary = subjects.map((subjectCode) => {
      const list = nodes.filter((n) => n.subjectCode === subjectCode);
      const count = (s: string) => list.filter((n) => statusByNode.get(String(n._id)) === s).length;
      const done = count("done");
      const plannedUntilToday = lessons.filter((l) => l.subjectCode === subjectCode && l.date <= today && l.status !== "cancelled").length;
      return {
        subjectCode,
        total: list.length,
        done,
        partial: count("partial"),
        missed: count("missed"),
        notStarted: list.filter((n) => !statusByNode.has(String(n._id)) || statusByNode.get(String(n._id)) === "planned").length,
        unreported: list.filter((n) => lateNodes.has(String(n._id))).length,
        /** positif = en retard sur sa propre progression, en nombre de séances */
        delay: Math.max(0, plannedUntilToday - done - count("partial")),
        byTerm: [1, 2, 3].map((term) => {
          const t = list.filter((n) => n.term === term);
          return { term, total: t.length, done: t.filter((n) => statusByNode.get(String(n._id)) === "done").length };
        }),
      };
    });
    res.json({ classLevel, subjects: summary });
  })
);

teacherRouter.get(
  "/progress/logbook",
  validate(rangeSchema, "query"),
  ah(async (req, res) => {
    const { from, to } = req.query as unknown as z.infer<typeof rangeSchema>;
    const lessons = await LessonInstance.find({ teacherId: uid(req), date: { $gte: from, $lte: to }, status: { $in: ["done", "partial", "missed"] } })
      .sort({ date: 1, start: 1 })
      .populate<{ nodeId: { title: string; objectives: string[] } }>("nodeId", "title objectives")
      .lean();
    const events = await ProgressEvent.find({ teacherId: uid(req), lessonId: { $in: lessons.map((l) => l._id) } })
      .sort({ recordedAt: -1 })
      .lean();
    const lastEvent = new Map<string, (typeof events)[number]>();
    for (const e of events) if (!lastEvent.has(String(e.lessonId))) lastEvent.set(String(e.lessonId), e);
    res.json(
      lessons.map((l) => {
        const e = lastEvent.get(String(l._id));
        return {
          date: l.date,
          start: l.start,
          end: l.end,
          classLevel: l.classLevel,
          subjectCode: l.subjectCode,
          title: l.nodeId?.title,
          status: l.status,
          objectives: (l.nodeId?.objectives ?? []).map((o, i) => ({ text: o, done: e?.objectivesDone?.includes(i) ?? l.status === "done" })),
          durationMin: e?.durationMin ?? null,
          note: e?.note ?? null,
          difficulties: e?.difficulties ?? null,
          toRedo: e?.toRedo ?? null,
        };
      })
    );
  })
);

/** Grille de progression : chaque leçon de l'année et son état (pour l'affichage en tuiles). */
teacherRouter.get(
  "/progress/grid",
  validate(z.object({ classLevel: z.enum(ALL_CLASS_LEVELS) }), "query"),
  ah(async (req, res) => {
    const classLevel = String(req.query.classLevel);
    const profile = await profileOf(uid(req));
    assertTeaches(profile, classLevel);
    const subjects = profile.assignments.find((a) => a.classLevel === classLevel)?.subjects ?? [];
    const [bySubject, lessons] = await Promise.all([
      lessonsFor(uid(req), classLevel, subjects),
      LessonInstance.find({ teacherId: uid(req), classLevel }).select("nodeId status").lean(),
    ]);
    const nodes = [...bySubject.values()].flatMap((v) => v.nodes);
    const rank: Record<string, number> = { done: 4, partial: 3, missed: 2, planned: 1 };
    const best = new Map<string, string>();
    for (const n of nodes) if ((n as { alreadyTaught?: boolean }).alreadyTaught) best.set(String(n._id), "done");
    for (const l of lessons) {
      const k = String(l.nodeId);
      if ((rank[l.status] ?? 0) > (rank[best.get(k) ?? ""] ?? 0)) best.set(k, l.status);
    }
    res.json(
      subjects.map((subjectCode) => ({
        subjectCode,
        source: bySubject.get(subjectCode)?.source ?? "official",
        lessons: nodes
          .filter((n) => n.subjectCode === subjectCode)
          .map((n) => ({ id: String(n._id), title: n.title, order: n.order, term: n.term ?? null, status: best.get(String(n._id)) ?? "none" })),
      }))
    );
  })
);


/* ───────────── Ma progression (curriculum personnel) ───────────── */

const classSubject = z.object({ classLevel: z.enum(ALL_CLASS_LEVELS), subjectCode: z.string().max(40) });

teacherRouter.get(
  "/curriculum",
  validate(classSubject, "query"),
  ah(async (req, res) => {
    const { classLevel, subjectCode } = req.query as { classLevel: string; subjectCode: string };
    const profile = await profileOf(uid(req));
    assertTeaches(profile, classLevel);
    const entry = (await lessonsFor(uid(req), classLevel, [subjectCode])).get(subjectCode)!;
    res.json({
      source: entry.source,
      lessons: entry.nodes.map((n) => ({
        id: String(n._id),
        title: n.title,
        objectives: n.objectives ?? [],
        order: n.order,
        term: n.term ?? null,
        alreadyTaught: Boolean((n as { alreadyTaught?: boolean }).alreadyTaught),
        hasLibrary: entry.source === "official" || Boolean((n as { matchedNodeId?: unknown }).matchedNodeId),
      })),
    });
  })
);

/** Aperçu sans enregistrement : l'enseignant vérifie la liste lue avant de valider. */
teacherRouter.post(
  "/curriculum/parse",
  validate(z.object({ text: z.string().min(3).max(60_000) })),
  ah(async (req, res) => {
    res.json({ lessons: parseProgression(req.body.text) });
  })
);

teacherRouter.put(
  "/curriculum",
  validate(
    classSubject.extend({
      lessons: z
        .array(z.object({ title: z.string().trim().min(2).max(200), objectives: z.array(z.string().max(300)).max(10).default([]), term: z.number().int().min(1).max(3).nullable().default(null), week: z.number().int().min(1).max(60).nullable().default(null) }))
        .min(1)
        .max(400),
      startAt: z.number().int().min(0).max(400).default(0),
      today: localDate,
    })
  ),
  ah(async (req, res) => {
    const { classLevel, subjectCode, lessons, startAt, today } = req.body;
    const profile = await profileOf(uid(req));
    assertTeaches(profile, classLevel);
    res.json(await saveTeacherCurriculum(uid(req), classLevel, subjectCode, lessons, today, startAt));
  })
);

teacherRouter.delete(
  "/curriculum",
  validate(classSubject.extend({ today: localDate }), "query"),
  ah(async (req, res) => {
    const { classLevel, subjectCode, today } = req.query as { classLevel: string; subjectCode: string; today: string };
    const profile = await profileOf(uid(req));
    assertTeaches(profile, classLevel);
    await resetTeacherCurriculum(uid(req), classLevel, subjectCode, today);
    res.status(204).end();
  })
);

/* ───────────── Mes fiches de préparation ───────────── */

const prepContent = z.object({
  objectives: z.array(z.string().max(400)).max(12).optional(),
  materials: z.array(z.string().max(300)).max(20).optional(),
  steps: z
    .array(z.object({ name: z.string().max(160), durationMin: z.number().int().min(1).max(120), teacherActivities: z.array(z.string().max(800)).max(15).default([]), learnerActivities: z.array(z.string().max(800)).max(15).default([]) }))
    .max(12)
    .optional(),
  writtenTrace: z.string().max(4000).optional(),
  exercises: z.array(z.object({ prompt: z.string().min(1).max(2000), answer: z.string().max(2000).default("") })).max(30).optional(),
  notes: z.string().max(6000).optional(),
  /** Rubriques propres à l'enseignant (« Domaine », « Prérequis »…), dans son vocabulaire. */
  extra: z.array(z.object({ label: z.string().trim().min(1).max(120), lines: z.array(z.string().max(800)).max(40) })).max(12).optional(),
});

async function ownNode(teacherId: string, nodeId: string) {
  // Une fiche se rattache à une leçon du programme officiel ou de la progression de l'enseignant lui-même.
  const node = await CurriculumNode.findOne({ _id: nodeId, $or: [{ ownerId: null }, { ownerId: teacherId }] }).lean();
  if (!node) throw notFound("Leçon introuvable");
  return node;
}

/** Liste des fiches de l'enseignant (titre et matière de la leçon), la plus récente d'abord. */
teacherRouter.get(
  "/preps",
  ah(async (req, res) => {
    const preps = await TeacherPrep.find({ teacherId: uid(req) }, { nodeId: 1, fileName: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(300).lean();
    const nodes = await CurriculumNode.find({ _id: { $in: preps.map((p) => p.nodeId) } }, { title: 1, subjectCode: 1, classLevel: 1, order: 1 }).lean();
    const byId = new Map(nodes.map((n) => [String(n._id), n]));
    res.json(
      preps.flatMap((p) => {
        const n = byId.get(String(p.nodeId));
        return n ? [{ nodeId: String(n._id), title: n.title, subjectCode: n.subjectCode, classLevel: n.classLevel, order: n.order, updatedAt: p.updatedAt }] : [];
      })
    );
  })
);

/**
 * Import d'une progression ou d'une fiche (PDF ou photo) : renvoie les données lues, sans rien enregistrer.
 * L'enseignant vérifie, puis valide avec PUT /curriculum ou PUT /preps/:nodeId.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 4 } });
teacherRouter.post(
  "/imports",
  (req, res, next) =>
    upload.single("file")(req, res, (err: unknown) => {
      if (err) return next((err as { code?: string }).code === "LIMIT_FILE_SIZE" ? badRequest("FILE_TOO_LARGE", "Fichier trop lourd (10 Mo maximum)") : badRequest("UPLOAD_INVALID", "Envoi invalide"));
      next();
    }),
  ah(async (req, res) => {
    const kind = z.enum(["curriculum", "prep"]).safeParse(req.body?.kind);
    if (!kind.success) throw badRequest("IMPORT_KIND", "Type d'import inconnu");
    const file = (req as typeof req & { file?: Express.Multer.File }).file;
    if (!file) throw badRequest("FILE_REQUIRED", "Ajoute un PDF ou une photo");
    res.json(await analyzeImport({ teacherId: uid(req), kind: kind.data, buffer: file.buffer, name: file.originalname }));
  })
);

teacherRouter.get(
  "/preps/:nodeId/preview",
  ah(async (req, res) => {
    const node = await ownNode(uid(req), String(req.params.nodeId));
    const [profile, user] = await Promise.all([profileOf(uid(req)), User.findById(uid(req)).lean()]);
    const today = new Date().toISOString().slice(0, 10);
    const { doc, usedPrep, usedLayout } = await composeLessonDoc({
      teacherId: uid(req),
      teacherName: user?.fullName ?? "",
      schoolName: profile.schoolName ?? "",
      lesson: { _id: node._id, nodeId: node._id, classLevel: node.classLevel, subjectCode: node.subjectCode, date: today, start: null, end: null },
      difficulty: "standard",
      illustrationLevel: profile.preferences?.illustrationLevel ?? "simple",
      includeAnswers: true,
      defaultLayout: (profile.prepLayout as PrepLayout | null) ?? null,
    });
    res.json({ ...previewOf(doc), usedPrep, usedLayout, adaptation: "not_needed", difficulty: "standard" });
  })
);

teacherRouter.get(
  "/preps/:nodeId",
  ah(async (req, res) => {
    await ownNode(uid(req), String(req.params.nodeId));
    const prep = await TeacherPrep.findOne({ teacherId: uid(req), nodeId: req.params.nodeId }).lean();
    res.json(prep ? { content: prep.content, layout: prep.layout ?? null, fileName: prep.fileName ?? null, fileUrl: prep.fileUrl ?? null, updatedAt: prep.updatedAt } : null);
  })
);

teacherRouter.put(
  "/preps/:nodeId",
  // Le fichier d'origine se désigne par l'identifiant de son dépôt : seul un fichier de l'enseignant lui-même est accepté.
  validate(z.object({ content: prepContent, uploadId: z.string().regex(/^[a-f\d]{24}$/i).optional(), layout: prepLayoutSchema.nullish() })),
  ah(async (req, res) => {
    await ownNode(uid(req), String(req.params.nodeId));
    const upload = req.body.uploadId ? await TeacherUpload.findOne({ _id: req.body.uploadId, teacherId: uid(req), kind: "prep" }).lean() : null;
    if (req.body.uploadId && !upload) throw notFound("Fichier introuvable");
    const prep = await TeacherPrep.findOneAndUpdate(
      { teacherId: uid(req), nodeId: req.params.nodeId },
      { content: req.body.content, ...(req.body.layout !== undefined ? { layout: req.body.layout } : {}), ...(upload ? { fileUrl: upload.url, fileName: upload.name ?? "fiche", fileMime: upload.mime } : {}) },
      { upsert: true, new: true }
    ).lean();
    // Le modèle de la dernière fiche importée devient celui de toutes les fiches de l'enseignant.
    if (req.body.layout) await TeacherProfile.updateOne({ userId: uid(req) }, { prepLayout: req.body.layout });
    res.json({ content: prep.content, fileName: prep.fileName ?? null, updatedAt: prep.updatedAt });
  })
);

teacherRouter.delete(
  "/preps/:nodeId",
  ah(async (req, res) => {
    await TeacherPrep.deleteOne({ teacherId: uid(req), nodeId: req.params.nodeId });
    res.status(204).end();
  })
);

/**
 * Document de la séance : la fiche de l'enseignant d'abord, complétée par la bibliothèque
 * (variante la plus proche du niveau et des illustrations choisis), avec l'en-tête de la classe.
 */
const documentOptions = z.object({
  difficulty: z.enum(["easy", "standard", "advanced"]).optional(),
  illustrationLevel: z.enum(["simple", "standard", "detailed"]).optional(),
  includeAnswers: z.boolean().default(true),
});

/** Options de composition d'une séance (aperçu et PDF identiques) : modèle de l'enseignant compris. */
async function composeOptions(req: AuthedRequest, body: z.infer<typeof documentOptions>): Promise<ComposeOptions> {
  const lesson = await LessonInstance.findOne({ _id: req.params.lessonId, teacherId: uid(req) }).lean();
  if (!lesson) throw notFound("Séance introuvable");
  const [profile, user] = await Promise.all([profileOf(uid(req)), User.findById(uid(req)).lean()]);
  return {
    teacherId: uid(req),
    teacherName: user?.fullName ?? "",
    schoolName: profile.schoolName ?? "",
    lesson,
    difficulty: body.difficulty ?? profile.preferences?.difficulty ?? "standard",
    illustrationLevel: body.illustrationLevel ?? profile.preferences?.illustrationLevel ?? "simple",
    includeAnswers: body.includeAnswers,
    defaultLayout: (profile.prepLayout as PrepLayout | null) ?? null,
  };
}

/** Aperçu fidèle : les blocs exacts que le PDF dessinera, au niveau demandé (adapté par l'IA si besoin). */
teacherRouter.post(
  "/lessons/:lessonId/preview",
  validate(documentOptions),
  ah(async (req, res) => {
    const { doc, usedPrep, usedLibrary, usedLayout, adaptation } = await composeLessonDoc(await composeOptions(req as AuthedRequest, req.body));
    res.json({ ...previewOf(doc), usedPrep, usedLibrary, usedLayout, adaptation, difficulty: doc.difficulty });
  })
);

teacherRouter.post(
  "/lessons/:lessonId/document",
  validate(documentOptions.extend({ format: z.enum(["pdf", "docx"]).default("pdf") })),
  ah(async (req, res) => {
    res.json(await buildLessonDocument({ ...(await composeOptions(req as AuthedRequest, req.body)), format: req.body.format }));
  })
);
