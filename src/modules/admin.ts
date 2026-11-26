import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { extractText, getDocumentProxy } from "unpdf";
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
import { buildLibraryParams, extractParams, generateParams, researchParams, SOURCE_DOC_TYPES, STEPS } from "../ai/pipeline.js";
import { reviewPdf } from "../services/exports.js";
import { readStoredFile, storeFile } from "../services/storage.js";
import { env } from "../config/env.js";
import { isAllowedHost, isUploadThingUrl } from "../ai/safe-fetch.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("admin"));

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

/**
 * Dépôt direct d'un document officiel (PDF reçu, téléchargé à la main…) : stocké, texte lu sur place.
 * Un même fichier n'est jamais déposé deux fois (empreinte SHA-256). Il reste « à vérifier » par un humain.
 */
const SOURCE_MAX_BYTES = 30 * 1024 * 1024;
const sourceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SOURCE_MAX_BYTES, files: 1, fields: 10 } });
const uploadMeta = z.object({
  title: z.string().trim().min(3).max(300),
  issuer: z.string().trim().min(2).max(160),
  docType: z.enum(SOURCE_DOC_TYPES).default("other"),
  usageRights: z.enum(["public_official", "licensed", "reference_only", "unknown"]).default("unknown"),
  publishedOn: z.string().trim().max(20).optional(),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

adminRouter.post(
  "/sources/upload",
  (req, res, next) =>
    sourceUpload.single("file")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) return next(badRequest(err.code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "UPLOAD_INVALID", err.code === "LIMIT_FILE_SIZE" ? "Fichier trop lourd (30 Mo maximum)" : "Envoi invalide"));
      next(err);
    }),
  ah(async (req, res) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw badRequest("FILE_MISSING", "Aucun fichier reçu");
    if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw badRequest("FILE_TYPE", "Seuls les PDF sont acceptés");
    const meta = uploadMeta.parse(req.body);
    const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const dup = await SourceDocument.findOne({ sha256 }).select("_id title").lean();
    if (dup) return res.status(409).json({ code: "DUPLICATE", message: `Déjà déposé : « ${dup.title} »`, id: String(dup._id) });

    let text = "";
    let pageCount = 0;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
      pageCount = pdf.numPages;
      text = String((await extractText(pdf, { mergePages: true })).text ?? "");
    } catch {
      throw badRequest("PDF_UNREADABLE", "Ce PDF ne peut pas être lu (protégé ou abîmé)");
    }
    const stored = await storeFile(`source-${crypto.randomBytes(8).toString("hex")}.pdf`, file.buffer, "application/pdf");
    const doc = await SourceDocument.create({
      ...meta,
      fileUrl: stored.url,
      fileKey: stored.key,
      sha256,
      pageCount,
      // Texte lisible : prêt pour l'extraction ; PDF scanné : l'IA lira les pages à l'extraction.
      ...(text.trim().length > 200 ? { extractedText: text.slice(0, 400_000), status: "extracted" } : { status: "fetched" }),
    });
    await audit(req, "source.upload", String(doc._id), { bytes: file.size, pages: pageCount });
    res.status(201).json({ ...doc.toObject(), extractedText: undefined, textChars: text.trim().length });
  })
);

/** Fichier d'une source (PDF), affiché dans l'admin pour vérification. */
adminRouter.get(
  "/sources/:id/file",
  validate(z.object({ id: objectId }), "params"),
  ah(async (req, res) => {
    const src = await SourceDocument.findById(req.params.id).select("title fileUrl").lean();
    if (!src?.fileUrl) throw notFound("Aucun fichier pour cette source");
    const data = await readStoredFile(src.fileUrl);
    if (!data) throw notFound("Fichier illisible");
    res.setHeader("Content-Type", data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="source-${src._id}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(data);
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
    const nodes = await CurriculumNode.find({ ...(req.query as Record<string, string>), ownerId: null }).sort({ classLevel: 1, subjectCode: 1, order: 1 }).limit(1000).lean();
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
      /** Recherche dans le titre (texte littéral, jamais une expression régulière fournie par le client). */
      q: z.string().trim().max(80).optional(),
    }),
    "query"
  ),
  ah(async (req, res) => {
    const { page, limit, q, ...filter } = req.query as any;
    if (q) filter.title = { $regex: String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
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

/**
 * PDF d'une ressource tel que les enseignants le recevront (version en cours ou une version passée),
 * pour relire AVANT de valider ou publier. Mention « À valider » tant qu'elle n'est pas publiée.
 */
adminRouter.get(
  "/resources/:id/pdf",
  validate(z.object({ id: objectId }), "params"),
  validate(z.object({ version: z.coerce.number().int().min(1).optional() }), "query"),
  ah(async (req, res) => {
    const r = await Resource.findById(req.params.id).lean();
    if (!r) throw notFound();
    const version = (req.query as { version?: number }).version;
    let subject: Parameters<typeof reviewPdf>[0] = r;
    if (version && version !== r.contentVersion) {
      const v = await ResourceVersion.findOne({ resourceId: r._id, contentVersion: version }).lean();
      if (!v) throw notFound("Version introuvable");
      const snap = v.snapshot as Partial<typeof r>;
      subject = { ...r, ...snap, contentVersion: version, status: "ARCHIVED" };
    }
    const data = await reviewPdf(subject);
    // Trace de relecture : exigée pour approuver ou publier cette version.
    await audit(req, "resource.pdf_view", String(r._id), { version: subject.contentVersion });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ressource-${r._id}-v${subject.contentVersion}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(data);
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
    // Valider, c'est avoir vu le document tel qu'il sera diffusé : le PDF de CETTE version, ouvert par CETTE personne.
    if (to === "APPROVED" || to === "PUBLISHED") {
      const seen = await AuditLog.exists({ actorId: me(req).userId, action: "resource.pdf_view", target: String(r._id), "meta.version": r.contentVersion });
      if (!seen) throw badRequest("PDF_NOT_REVIEWED", "Affiche le PDF de la version en cours avant de valider");
    }
    if (to === "APPROVED") {
      // L'administrateur est le relecteur humain : il valide après avoir lu le PDF de cette version (contrôle ci-dessus).
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

/* ───────────── Construire ma bibliothèque (analyse sans dépense IA) ───────────── */

const planSchema = z.object({
  subsystem: z.enum(["francophone", "anglophone"]),
  classLevel: z.enum(ALL_CLASS_LEVELS as unknown as [string, ...string[]]),
  source: z.enum(["research", "imported"]).default("imported"),
  referenceYear: z.string().regex(/^\d{4}(-\d{4})?$/).optional(),
  types: z.array(z.enum(RESOURCE_TYPES)).min(1).max(6).default(["lesson_plan", "exercises", "assessment"]),
  difficulties: z.array(z.enum(DIFFICULTIES)).min(1).max(3).default(["standard"]),
  term: z.number().int().min(1).max(3).optional(),
  perJobBudgetUsd: z.number().min(0.05).max(10).default(0.5),
});

/**
 * Analyse préalable d'une classe entière : documents, sources, matières, compétences, ressources et coût prévus,
 * points à vérifier. Lecture seule de la base : aucun appel IA, aucune dépense.
 */
adminRouter.post(
  "/library/plan",
  validate(planSchema),
  ah(async (req, res) => {
    const p = req.body as z.infer<typeof planSchema>;
    const base: Record<string, unknown> = { classLevel: p.classLevel, ownerId: null };
    if (p.term) base.term = p.term;
    const [lessons, pendingLessons, competencies, subjects] = await Promise.all([
      CurriculumNode.find({ ...base, kind: "lesson", status: "validated" }).select("subjectCode objectives sourceRefs curriculumVersion").lean(),
      CurriculumNode.countDocuments({ ...base, kind: "lesson", status: "extracted" }),
      CurriculumNode.countDocuments({ ...base, kind: "competency", status: { $ne: "retired" } }),
      Subject.find({ subsystem: p.subsystem }).select("code name").lean(),
    ]);
    const sourceIds = [...new Set(lessons.flatMap((l) => (l.sourceRefs ?? []).map((r) => String(r.sourceId))).filter(Boolean))];
    const docs = await SourceDocument.find(sourceIds.length ? { _id: { $in: sourceIds } } : { _id: null }).select("title issuer status docType publishedOn").lean();
    const allSources = await SourceDocument.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]);

    // Ressources déjà présentes (jamais régénérées) et ressources à produire.
    const nodeIds = lessons.map((l) => l._id);
    const existing = await Resource.find({ nodeId: { $in: nodeIds }, type: { $in: p.types }, status: { $nin: ["REJECTED", "ARCHIVED"] }, illustrationLevel: "simple" }).select("nodeId type difficulty illustrations").lean();
    const have = new Set(existing.map((r) => `${r.nodeId}|${r.type}|${r.difficulty}`));
    const bySubject = new Map<string, { lessons: number; objectives: number; planned: number; existing: number }>();
    let planned = 0;
    for (const l of lessons) {
      const row = bySubject.get(l.subjectCode) ?? { lessons: 0, objectives: 0, planned: 0, existing: 0 };
      row.lessons++;
      row.objectives += l.objectives?.length ?? 0;
      for (const t of p.types)
        for (const d of p.difficulties) {
          if (have.has(`${l._id}|${t}|${d}`)) row.existing++;
          else {
            row.planned++;
            planned++;
          }
        }
      bySubject.set(l.subjectCode, row);
    }
    const capped = Math.min(planned, env.aiMaxJobsPerBuild);

    // Coût : moyenne réelle des générations passées ; sinon seul le plafond est connu.
    const past = await AiJob.aggregate<{ avg: number; n: number }>([
      { $match: { kind: "generate_resource", status: { $in: ["done", "waiting_review"] }, spentUsd: { $gt: 0 } } },
      { $sort: { createdAt: -1 } },
      { $limit: 200 },
      { $group: { _id: null, avg: { $avg: "$spentUsd" }, n: { $sum: 1 } } },
    ]);
    const avg = past[0]?.n ? past[0].avg : null;
    const illustrationsReady = existing.reduce((n, r) => n + (r.illustrations?.length ?? 0), 0);

    const names = new Map(subjects.map((x) => [x.code, x.name]));
    const checks: { level: "warn" | "info"; text: string }[] = [];
    const missing = subjects.filter((x) => !bySubject.has(x.code));
    if (!lessons.length) checks.push({ level: "warn", text: "Aucune leçon validée pour cette classe : importe ou extrais d'abord le programme officiel (Sources), puis valide-le (Référentiel)." });
    if (missing.length && lessons.length) checks.push({ level: "warn", text: `Matières sans leçon validée : ${missing.map((x) => x.name).join(", ")}.` });
    if (pendingLessons) checks.push({ level: "warn", text: `${pendingLessons} leçon(s) extraite(s) attendent ta validation dans le Référentiel (non comptées).` });
    const unverified = docs.filter((d) => d.status !== "verified");
    if (unverified.length) checks.push({ level: "warn", text: `${unverified.length} document(s) source non vérifié(s) : vérifie-les avant de publier.` });
    if (planned > capped) checks.push({ level: "info", text: `Plafond de ${env.aiMaxJobsPerBuild} générations par lancement : relance une fois le premier lot terminé.` });
    if (p.source === "research") checks.push({ level: "info", text: "Recherche autonome : les documents trouvés restent « à vérifier » dans Sources ; rien n'est utilisé sans ta validation." });
    checks.push({ level: "info", text: "Illustrations : celles des ressources existantes sont réutilisées ; la génération d'images de la bibliothèque n'est pas encore branchée (aucune prévue)." });
    if (avg === null) checks.push({ level: "info", text: "Pas encore d'historique de génération : seul le coût maximal est connu." });

    res.json({
      documents: docs.map((d) => ({ id: d._id, title: d.title, issuer: d.issuer, status: d.status, docType: d.docType, publishedOn: d.publishedOn ?? null })),
      sources: { verified: allSources.find((x) => x._id === "verified")?.n ?? 0, toVerify: allSources.filter((x) => x._id !== "verified" && x._id !== "rejected").reduce((n, x) => n + x.n, 0) },
      subjects: [...bySubject.entries()].map(([code, r]) => ({ code, name: names.get(code) ?? code, ...r })).sort((a, b) => a.name.localeCompare(b.name)),
      missingSubjects: missing.map((x) => ({ code: x.code, name: x.name })),
      competencies: { nodes: competencies, objectives: lessons.reduce((n, l) => n + (l.objectives?.length ?? 0), 0), lessons: lessons.length },
      resources: { planned, launchable: capped, existing: existing.length },
      illustrations: { planned: 0, reusable: illustrationsReady },
      cost: { avgPerResourceUsd: avg, estimateUsd: avg === null ? null : Math.round(avg * capped * 100) / 100, maxUsd: Math.round(p.perJobBudgetUsd * capped * 100) / 100, basedOn: past[0]?.n ?? 0 },
      checks,
      referenceYear: p.referenceYear ?? null,
    });
  })
);

/* ───────────── Tâches IA ───────────── */

const jobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generate_resource"), params: generateParams, budgetUsd: z.number().min(0.05).max(20).optional() }),
  z.object({ kind: z.literal("build_library"), params: buildLibraryParams, budgetUsd: z.number().min(0).max(1).optional() }),
  z.object({ kind: z.literal("extract_source"), params: extractParams, budgetUsd: z.number().min(0.05).max(20).optional() }),
  z.object({ kind: z.literal("review_resource"), params: z.object({ resourceId: objectId }), budgetUsd: z.number().min(0.05).max(5).optional() }),
  // Recherche de documents officiels : les candidats trouvés restent « à vérifier » dans Sources.
  z.object({ kind: z.literal("research_sources"), params: researchParams, budgetUsd: z.number().min(0.05).max(2).optional() }),
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
  validate(pageQuery.extend({ role: z.enum(["teacher", "admin"]).optional() }), "query"),
  ah(async (req, res) => {
    const { page, limit, role } = req.query as any;
    const filter = role ? { role } : {};
    const [items, total] = await Promise.all([
      User.find(filter).select("fullName email phone role disabled mfaEnabled lastLoginAt createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    res.json({ items, total });
  })
);

adminRouter.patch(
  "/users/:id",
  requireRole("admin"),
  validate(z.object({ role: z.enum(["teacher", "admin"]).optional(), disabled: z.boolean().optional(), resetMfa: z.literal(true).optional() })),
  ah(async (req, res) => {
    if (req.params.id === me(req).userId) throw badRequest("SELF_EDIT", "Tu ne peux pas modifier ton propre rôle");
    const { resetMfa, ...patch } = req.body as { role?: string; disabled?: boolean; resetMfa?: true };
    // Téléphone perdu : la personne réactivera la double authentification à sa prochaine connexion.
    const mfaReset = resetMfa ? { mfaEnabled: false, $unset: { mfaSecretEnc: 1, mfaPendingEnc: 1, mfaRecoveryHashes: 1, mfaLastStep: 1 } } : {};
    const u = await User.findByIdAndUpdate(req.params.id, { ...patch, ...mfaReset }, { new: true }).select("fullName email role disabled mfaEnabled").lean();
    if (!u) throw notFound();
    // Compte désactivé, rôle modifié ou 2FA réinitialisée : toutes ses sessions sont fermées immédiatement.
    if (req.body.disabled === true || req.body.role || resetMfa) {
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
