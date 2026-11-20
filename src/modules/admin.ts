import { Router } from "express";
import { z } from "zod";
import {
  AcademicCalendar,
  AiJob,
  AiUsageLog,
  ALL_CLASS_LEVELS,
  AuditLog,
  CurriculumNode,
  DIFFICULTIES,
  EditorialReview,
  ILLUSTRATION_LEVELS,
  RESOURCE_STATUSES,
  RESOURCE_TYPES,
  Resource,
  ResourceVersion,
  SourceDocument,
  STATUS_TRANSITIONS,
  Subject,
  TeacherProfile,
  User,
  Session,
  type ResourceStatus,
} from "../models/index.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah, badRequest, forbidden, notFound } from "../utils/http-error.js";
import { lessonContentSchema, deterministicChecks } from "../services/content-schema.js";
import { buildLibraryParams, extractParams, generateParams, STEPS } from "../ai/pipeline.js";
import { env } from "../config/env.js";
import { isAllowedHost, isUploadThingUrl } from "../ai/safe-fetch.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("reviewer", "admin"));

const me = (req: unknown) => req as AuthedRequest;
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

async function audit(req: unknown, action: string, target?: string, meta?: unknown) {
  const r = me(req);
  await AuditLog.create({ actorId: r.userId, action, target, meta, ip: r.ip });
}

/* ───────────── Tableau de bord ───────────── */

adminRouter.get(
  "/stats",
  ah(async (_req, res) => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [byStatus, teachers, nodes, sources, jobs, cost] = await Promise.all([
      Resource.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      TeacherProfile.countDocuments(),
      CurriculumNode.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      SourceDocument.countDocuments(),
      AiJob.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      AiUsageLog.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, cost: { $sum: "$costUsd" }, calls: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const toMap = (rows: { _id: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r._id, r.n]));
    res.json({
      resources: toMap(byStatus),
      teachers,
      nodes: toMap(nodes),
      sources,
      jobs: toMap(jobs),
      costByDay: cost.map((c) => ({ day: c._id, costUsd: Number(c.cost.toFixed(4)), calls: c.calls })),
      aiConfigured: Boolean(env.openrouterApiKey),
    });
  })
);

/* ───────────── Sources documentaires ───────────── */

const sourceSchema = z.object({
  title: z.string().trim().min(3).max(240),
  issuer: z.string().trim().min(2).max(160),
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "Adresse web http(s) attendue").optional(),
  /** Fichier envoyé via UploadThing uniquement (jamais une URL arbitraire). */
  fileUrl: z.string().url().refine(isUploadThingUrl, "Fichier attendu depuis le stockage PEDAGO").optional(),
  fileKey: z.string().max(200).optional(),
  publishedOn: z.string().max(20).optional(),
  reference: z.string().max(200).optional(),
  docType: z.enum(["curriculum", "law", "calendar", "textbook_list", "exam", "guide", "other"]).default("other"),
  usageRights: z.enum(["public_official", "licensed", "reference_only", "unknown"]).default("unknown"),
  nextReviewOn: z.string().max(20).optional(),
  notes: z.string().max(2000).optional(),
});

adminRouter.get(
  "/sources",
  validate(pageQuery.extend({ status: z.string().optional() }), "query"),
  ah(async (req, res) => {
    const { page, limit, status } = req.query as any;
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      SourceDocument.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SourceDocument.countDocuments(filter),
    ]);
    res.json({ items, total });
  })
);

adminRouter.post(
  "/sources",
  validate(sourceSchema),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof sourceSchema>;
    if (body.url && !isAllowedHost(new URL(body.url).hostname)) {
      throw badRequest("DOMAIN_NOT_ALLOWED", "Ce domaine n'est pas dans la liste blanche des sources officielles");
    }
    const doc = await SourceDocument.create(body);
    await audit(req, "source.create", String(doc._id));
    res.status(201).json(doc);
  })
);

adminRouter.patch(
  "/sources/:id",
  validate(sourceSchema.partial().extend({ status: z.enum(["pending", "fetched", "extracted", "verified", "rejected"]).optional() })),
  ah(async (req, res) => {
    const doc = await SourceDocument.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    if (!doc) throw notFound();
    await audit(req, "source.update", String(doc._id), req.body);
    res.json(doc);
  })
);

adminRouter.get(
  "/sources/:id/text",
  ah(async (req, res) => {
    const doc = await SourceDocument.findById(req.params.id).select("+extractedText title").lean();
    if (!doc) throw notFound();
    res.json({ title: doc.title, text: doc.extractedText ?? "" });
  })
);

/* ───────────── Référentiel ───────────── */

adminRouter.get(
  "/subjects",
  ah(async (_req, res) => {
    res.json(await Subject.find().sort({ subsystem: 1, order: 1 }).lean());
  })
);

adminRouter.get(
  "/nodes",
  validate(
    z.object({
      classLevel: z.enum(ALL_CLASS_LEVELS).optional(),
      subjectCode: z.string().optional(),
      status: z.enum(["extracted", "validated", "retired"]).optional(),
      kind: z.enum(["domain", "unit", "competency", "lesson"]).optional(),
    }),
    "query"
  ),
  ah(async (req, res) => {
    const nodes = await CurriculumNode.find(req.query as Record<string, string>).sort({ classLevel: 1, subjectCode: 1, order: 1 }).limit(1000).lean();
    res.json(nodes);
  })
);

const nodeSchema = z.object({
  subsystem: z.enum(["francophone", "anglophone"]),
  classLevel: z.enum(ALL_CLASS_LEVELS),
  subjectCode: z.string().max(40),
  kind: z.enum(["domain", "unit", "competency", "lesson"]),
  parentId: objectId.optional(),
  title: z.string().trim().min(2).max(240),
  description: z.string().max(4000).optional(),
  objectives: z.array(z.string().max(400)).max(15).default([]),
  durationMin: z.number().int().min(5).max(240).default(45),
  order: z.number().int().min(0).default(0),
  term: z.number().int().min(1).max(3).optional(),
  priority: z.number().int().min(1).max(3).default(2),
  prerequisites: z.array(objectId).max(20).default([]),
  sourceRefs: z.array(z.object({ sourceId: objectId, pages: z.array(z.number().int()).max(50) })).max(10).default([]),
  curriculumVersion: z.string().min(2).max(40),
  status: z.enum(["extracted", "validated", "retired"]).default("extracted"),
});

adminRouter.post(
  "/nodes",
  validate(nodeSchema),
  ah(async (req, res) => {
    const node = await CurriculumNode.create(req.body);
    await audit(req, "node.create", String(node._id));
    res.status(201).json(node);
  })
);

adminRouter.patch(
  "/nodes/:id",
  validate(nodeSchema.partial()),
  ah(async (req, res) => {
    const node = await CurriculumNode.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }).lean();
    if (!node) throw notFound();
    await audit(req, "node.update", String(node._id), req.body);
    res.json(node);
  })
);

/* ───────────── Ressources & relecture ───────────── */

adminRouter.get(
  "/resources",
  validate(
    pageQuery.extend({
      status: z.enum(RESOURCE_STATUSES).optional(),
      classLevel: z.enum(ALL_CLASS_LEVELS).optional(),
      subjectCode: z.string().optional(),
      type: z.enum(RESOURCE_TYPES).optional(),
    }),
    "query"
  ),
  ah(async (req, res) => {
    const { page, limit, ...filter } = req.query as any;
    const [items, total] = await Promise.all([
      Resource.find(filter)
        .select("-content")
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Resource.countDocuments(filter),
    ]);
    res.json({ items, total });
  })
);

adminRouter.get(
  "/resources/:id",
  ah(async (req, res) => {
    const r = await Resource.findById(req.params.id).lean();
    if (!r) throw notFound();
    const [node, sources, reviews, versions] = await Promise.all([
      CurriculumNode.findById(r.nodeId).lean(),
      SourceDocument.find({ _id: { $in: r.sources.map((s) => s.sourceId) } }).lean(),
      EditorialReview.find({ resourceId: r._id }).sort({ createdAt: -1 }).populate("reviewerId", "fullName").lean(),
      ResourceVersion.find({ resourceId: r._id }).select("contentVersion createdAt reason").sort({ contentVersion: -1 }).lean(),
    ]);
    res.json({ resource: r, node, sources, reviews, versions });
  })
);

const resourceBody = z.object({
  type: z.enum(RESOURCE_TYPES),
  nodeId: objectId,
  title: z.string().trim().min(3).max(240),
  summary: z.string().max(600).optional(),
  difficulty: z.enum(DIFFICULTIES).default("standard"),
  illustrationLevel: z.enum(ILLUSTRATION_LEVELS).default("simple"),
  content: lessonContentSchema,
  illustrations: z.array(z.object({ url: z.string().url(), key: z.string().optional(), caption: z.string().max(300).optional(), license: z.string().max(200).optional() })).max(30).default([]),
  sources: z.array(z.object({ sourceId: objectId, pages: z.array(z.number().int()).max(50), note: z.string().max(400).optional() })).max(10).default([]),
});

adminRouter.post(
  "/resources",
  validate(resourceBody),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof resourceBody>;
    const node = await CurriculumNode.findById(body.nodeId).lean();
    if (!node) throw badRequest("NODE_NOT_FOUND", "Nœud du référentiel introuvable");
    const r = await Resource.create({
      ...body,
      subsystem: node.subsystem,
      classLevel: node.classLevel,
      subjectCode: node.subjectCode,
      durationMin: node.durationMin,
      curriculumVersion: node.curriculumVersion,
      origin: "human",
      lastEditedBy: me(req).userId,
      status: "DRAFT",
    });
    await audit(req, "resource.create", String(r._id));
    res.status(201).json(r);
  })
);

/** Une ressource publiée ne se modifie jamais en silence : il faut d'abord la « réviser ». */
adminRouter.put(
  "/resources/:id",
  validate(resourceBody.partial().omit({ nodeId: true, type: true })),
  ah(async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) throw notFound();
    if (["PUBLISHED", "APPROVED", "ARCHIVED"].includes(r.status)) {
      throw badRequest("LOCKED", "Ressource verrouillée : crée une révision pour la modifier");
    }
    Object.assign(r, req.body, { lastEditedBy: me(req).userId });
    await r.save();
    await audit(req, "resource.update", String(r._id));
    res.json({ resource: r, checks: deterministicChecks(lessonContentSchema.parse(r.content)) });
  })
);

adminRouter.post(
  "/resources/:id/revise",
  requireRole("admin"),
  ah(async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) throw notFound();
    if (r.status !== "PUBLISHED") throw badRequest("NOT_PUBLISHED", "Seule une ressource publiée peut être révisée");
    r.status = "HUMAN_REVIEW";
    r.lastEditedBy = me(req).userId as any;
    r.contentVersion += 1;
    r.approvedAt = undefined;
    r.approvedBy = undefined;
    await r.save();
    await audit(req, "resource.revise", String(r._id));
    res.json(r);
  })
);

adminRouter.post(
  "/resources/:id/transition",
  validate(z.object({ to: z.enum(RESOURCE_STATUSES), comment: z.string().max(4000).optional() })),
  ah(async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) throw notFound();
    const to = req.body.to as ResourceStatus;
    const from = r.status as ResourceStatus;
    if (!STATUS_TRANSITIONS[from].includes(to)) throw badRequest("BAD_TRANSITION", `Transition ${from} → ${to} interdite`);
    if ((to === "PUBLISHED" || to === "ARCHIVED") && me(req).role !== "admin") throw forbidden("ADMIN_ONLY", "Seul un administrateur publie ou archive");
    if (to === "APPROVED") {
      // Principe des quatre yeux : on ne valide pas son propre travail.
      if (r.lastEditedBy && String(r.lastEditedBy) === me(req).userId) {
        throw forbidden("SELF_APPROVAL", "Une autre personne doit valider cette ressource");
      }
      const blocking = deterministicChecks(lessonContentSchema.parse(r.content)).filter((i) => i.severity === "error");
      if (blocking.length) throw badRequest("CHECKS_FAILED", blocking.map((b) => b.message).join(" · "));
      if (!r.sources.length && r.origin === "ai") throw badRequest("NO_SOURCE", "Une ressource IA doit citer au moins une source");
      r.approvedBy = me(req).userId as any;
      r.approvedAt = new Date();
    }
    if (to === "PUBLISHED") {
      if (!r.approvedAt) throw badRequest("NOT_APPROVED", "Validation humaine requise avant publication");
      r.publishedAt = new Date();
      await ResourceVersion.updateOne(
        { resourceId: r._id, contentVersion: r.contentVersion },
        { $setOnInsert: { snapshot: r.toObject(), authorId: me(req).userId, reason: req.body.comment } },
        { upsert: true }
      );
    }
    r.status = to;
    await r.save();
    await EditorialReview.create({
      resourceId: r._id,
      reviewerId: me(req).userId,
      decision: to === "APPROVED" ? "approve" : to === "REJECTED" ? "reject" : "comment",
      comment: req.body.comment,
      fromStatus: from,
      toStatus: to,
      contentVersion: r.contentVersion,
    });
    await audit(req, "resource.transition", String(r._id), { from, to });
    res.json(r);
  })
);

adminRouter.post(
  "/resources/:id/comments",
  validate(z.object({ comment: z.string().min(1).max(4000) })),
  ah(async (req, res) => {
    const r = await Resource.findById(req.params.id).select("status contentVersion").lean();
    if (!r) throw notFound();
    const review = await EditorialReview.create({
      resourceId: r._id,
      reviewerId: me(req).userId,
      decision: "comment",
      comment: req.body.comment,
      contentVersion: r.contentVersion,
    });
    res.status(201).json(review);
  })
);

/* ───────────── Tâches IA ───────────── */

const jobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generate_resource"), params: generateParams, budgetUsd: z.number().min(0.05).max(20).optional() }),
  z.object({ kind: z.literal("build_library"), params: buildLibraryParams, budgetUsd: z.number().min(0).max(1).optional() }),
  z.object({ kind: z.literal("extract_source"), params: extractParams, budgetUsd: z.number().min(0.05).max(20).optional() }),
  z.object({ kind: z.literal("review_resource"), params: z.object({ resourceId: objectId }), budgetUsd: z.number().min(0.05).max(5).optional() }),
]);

adminRouter.post(
  "/ai/jobs",
  requireRole("admin"),
  validate(jobSchema),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof jobSchema>;
    if (!env.openrouterApiKey) throw badRequest("AI_NOT_CONFIGURED", "Clé OpenRouter non configurée : aucune tâche IA ne peut être lancée");
    const job = await AiJob.create({
      kind: body.kind,
      params: body.params,
      steps: STEPS[body.kind].map((name) => ({ name })),
      budgetUsd: body.budgetUsd ?? (body.kind === "build_library" ? 0 : env.aiJobDefaultBudgetUsd),
      createdBy: me(req).userId,
    });
    await audit(req, "ai.job.create", String(job._id), { kind: body.kind });
    res.status(201).json(job);
  })
);

adminRouter.get(
  "/ai/jobs",
  validate(pageQuery.extend({ status: z.string().optional(), kind: z.string().optional() }), "query"),
  ah(async (req, res) => {
    const { page, limit, ...filter } = req.query as any;
    const [items, total] = await Promise.all([
      AiJob.find(filter).select("-steps.output").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AiJob.countDocuments(filter),
    ]);
    res.json({ items, total });
  })
);

adminRouter.get(
  "/ai/jobs/:id",
  ah(async (req, res) => {
    const job = await AiJob.findById(req.params.id).lean();
    if (!job) throw notFound();
    const usage = await AiUsageLog.find({ jobId: job._id }).sort({ createdAt: 1 }).lean();
    res.json({ job, usage });
  })
);

adminRouter.post(
  "/ai/jobs/:id/cancel",
  requireRole("admin"),
  ah(async (req, res) => {
    const out = await AiJob.updateOne({ _id: req.params.id, status: { $in: ["queued", "running"] } }, { status: "cancelled" });
    if (!out.matchedCount) throw badRequest("NOT_CANCELLABLE", "Tâche non annulable");
    res.status(204).end();
  })
);

adminRouter.post(
  "/ai/jobs/:id/retry",
  requireRole("admin"),
  validate(z.object({ extraBudgetUsd: z.number().min(0).max(20).default(0) })),
  ah(async (req, res) => {
    const job = await AiJob.findById(req.params.id);
    if (!job || !["failed", "budget_exceeded", "cancelled"].includes(job.status)) throw badRequest("NOT_RETRYABLE", "Tâche non relançable");
    // Reprise à l'étape échouée, sans refaire les étapes terminées.
    for (const s of job.steps) if (s.status !== "done" && s.status !== "skipped") { s.status = "pending"; s.attempts = 0; }
    job.budgetUsd += req.body.extraBudgetUsd;
    job.status = "queued";
    job.nextRunAt = new Date();
    await job.save();
    res.json(job);
  })
);

adminRouter.get(
  "/ai/usage",
  ah(async (_req, res) => {
    const rows = await AiUsageLog.aggregate([
      { $group: { _id: { model: "$model", step: "$step" }, calls: { $sum: 1 }, cost: { $sum: "$costUsd" }, tokensIn: { $sum: "$tokensIn" }, tokensOut: { $sum: "$tokensOut" }, cached: { $sum: "$cachedTokens" }, avgLatency: { $avg: "$latencyMs" }, failures: { $sum: { $cond: ["$ok", 0, 1] } } } },
      { $sort: { cost: -1 } },
    ]);
    res.json(rows.map((r) => ({ model: r._id.model, step: r._id.step, calls: r.calls, costUsd: r.cost, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cachedTokens: r.cached, avgLatencyMs: Math.round(r.avgLatency ?? 0), failures: r.failures })));
  })
);

/* ───────────── Calendrier & utilisateurs ───────────── */

const calendarSchema = z.object({
  schoolYear: z.string().regex(/^\d{4}-\d{4}$/),
  startsOn: z.string(),
  endsOn: z.string(),
  terms: z.array(z.object({ number: z.number().int().min(1).max(3), startsOn: z.string(), endsOn: z.string() })).max(3),
  breaks: z.array(z.object({ label: z.string().max(120), startsOn: z.string(), endsOn: z.string(), kind: z.enum(["holiday", "vacation", "exam"]) })).max(60),
  verified: z.boolean().default(false),
  sourceId: objectId.optional(),
});

adminRouter.get("/calendars", ah(async (_req, res) => { res.json(await AcademicCalendar.find().sort({ schoolYear: -1 }).lean()); }));

adminRouter.put(
  "/calendars",
  requireRole("admin"),
  validate(calendarSchema),
  ah(async (req, res) => {
    const cal = await AcademicCalendar.findOneAndUpdate({ schoolYear: req.body.schoolYear }, req.body, { upsert: true, new: true }).lean();
    await audit(req, "calendar.update", req.body.schoolYear);
    res.json(cal);
  })
);

adminRouter.get(
  "/users",
  requireRole("admin"),
  validate(pageQuery.extend({ role: z.enum(["teacher", "reviewer", "admin"]).optional() }), "query"),
  ah(async (req, res) => {
    const { page, limit, role } = req.query as any;
    const filter = role ? { role } : {};
    const [items, total] = await Promise.all([
      User.find(filter).select("fullName email phone role disabled lastLoginAt createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    res.json({ items, total });
  })
);

adminRouter.patch(
  "/users/:id",
  requireRole("admin"),
  validate(z.object({ role: z.enum(["teacher", "reviewer", "admin"]).optional(), disabled: z.boolean().optional() })),
  ah(async (req, res) => {
    if (req.params.id === me(req).userId) throw badRequest("SELF_EDIT", "Tu ne peux pas modifier ton propre rôle");
    const u = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select("fullName email role disabled").lean();
    if (!u) throw notFound();
    // Compte désactivé ou rôle modifié : toutes ses sessions sont fermées immédiatement.
    if (req.body.disabled === true || req.body.role) {
      await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
    }
    await audit(req, "user.update", String(u._id), req.body);
    res.json(u);
  })
);

adminRouter.get(
  "/audit",
  requireRole("admin"),
  ah(async (_req, res) => {
    res.json(await AuditLog.find().sort({ createdAt: -1 }).limit(200).populate("actorId", "fullName").lean());
  })
);
