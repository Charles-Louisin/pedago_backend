import { Router } from "express";
import { z } from "zod";
import { ALL_CLASS_LEVELS, CurriculumNode, DIFFICULTIES, LessonInstance, RESOURCE_TYPES, Resource, SourceDocument, TeacherProfile } from "../models/index.js";
import { requireAuth, requireVerifiedEmail, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah, badRequest, notFound } from "../utils/http-error.js";
import { ensureExport, resourcePreview } from "../services/exports.js";
import { isLocalDate } from "../utils/dates.js";
import { getCalendar } from "../services/planning.js";

export const libraryRouter = Router();
libraryRouter.use(requireAuth, requireVerifiedEmail);

const LIST_FIELDS = "_id type title summary classLevel subjectCode nodeId difficulty illustrationLevel durationMin contentVersion updatedAt";

const searchSchema = z.object({
  classLevel: z.enum(ALL_CLASS_LEVELS).optional(),
  subjectCode: z.string().max(40).optional(),
  type: z.enum(RESOURCE_TYPES).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  nodeId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

libraryRouter.get(
  "/resources",
  validate(searchSchema, "query"),
  ah(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof searchSchema>;
    const filter: Record<string, unknown> = { status: "PUBLISHED" };
    for (const k of ["classLevel", "subjectCode", "type", "difficulty", "nodeId"] as const) if (q[k]) filter[k] = q[k];
    if (q.q) filter.$text = { $search: q.q };
    const [items, total] = await Promise.all([
      Resource.find(filter)
        .select(LIST_FIELDS)
        .sort(q.q ? { score: { $meta: "textScore" } } : { classLevel: 1, subjectCode: 1, title: 1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      Resource.countDocuments(filter),
    ]);
    res.json({ items: items.map(({ _id, ...r }) => ({ id: String(_id), ...r })), total, page: q.page, limit: q.limit });
  })
);

/** Ressource complète, avec traçabilité (sources, pages, version, validation humaine). */
/**
 * Aperçu d'une ressource publiée : exactement les blocs que son PDF dessine (titre, cartouche, rubriques,
 * tableau), pour la voir « comme sur papier » dans l'app avant de la télécharger.
 */
libraryRouter.get(
  "/resources/:id/preview",
  ah(async (req, res) => {
    const r = await Resource.findOne({ _id: req.params.id, status: "PUBLISHED" }).lean();
    if (!r) throw notFound("Ressource introuvable");
    res.set({ ETag: `W/"p-${r._id}-${r.contentVersion}"`, "Cache-Control": "private, no-cache" });
    if (req.fresh) return res.status(304).end();
    res.json({ ...(await resourcePreview(r)), contentVersion: r.contentVersion });
  })
);

libraryRouter.get(
  "/resources/:id",
  ah(async (req, res) => {
    const r = await Resource.findOne({ _id: req.params.id, status: "PUBLISHED" }).lean();
    if (!r) throw notFound("Ressource introuvable");
    const [node, sources] = await Promise.all([
      CurriculumNode.findById(r.nodeId).select("title objectives curriculumVersion").lean(),
      SourceDocument.find({ _id: { $in: r.sources.map((s) => s.sourceId) } }).select("title issuer url publishedOn consultedAt reference").lean(),
    ]);
    // Revalidation légère : 304 sans corps si la version n'a pas changé.
    res.set({ ETag: `W/"${r._id}-${r.contentVersion}"`, "Cache-Control": "private, no-cache" });
    if (req.fresh) return res.status(304).end();
    res.json({
      id: String(r._id),
      type: r.type,
      title: r.title,
      summary: r.summary,
      classLevel: r.classLevel,
      subjectCode: r.subjectCode,
      difficulty: r.difficulty,
      illustrationLevel: r.illustrationLevel,
      durationMin: r.durationMin,
      content: r.content,
      illustrations: r.illustrations,
      contentVersion: r.contentVersion,
      curriculumVersion: r.curriculumVersion,
      publishedAt: r.publishedAt,
      humanValidated: Boolean(r.approvedAt),
      node: node ? { id: String(node._id), title: node.title, objectives: node.objectives } : null,
      sources: r.sources.map((s) => {
        const doc = sources.find((d) => String(d._id) === String(s.sourceId));
        return { title: doc?.title, issuer: doc?.issuer, url: doc?.url, publishedOn: doc?.publishedOn, consultedAt: doc?.consultedAt, pages: s.pages, note: s.note };
      }),
      exports: {
        pdf: r.assets?.pdf?.contentVersion === r.contentVersion ? r.assets.pdf : null,
        docx: r.assets?.docx?.contentVersion === r.contentVersion ? r.assets.docx : null,
      },
    });
  })
);

/** Retourne l'URL du fichier PDF/Word (généré à la première demande, puis réutilisé). */
libraryRouter.get(
  "/resources/:id/export/:format",
  ah(async (req, res) => {
    const format = req.params.format;
    if (format !== "pdf" && format !== "docx") throw badRequest("BAD_FORMAT", "Format pdf ou docx attendu");
    const asset = await ensureExport(String(req.params.id), format);
    if (!asset) throw notFound("Ressource introuvable");
    res.json({ url: asset.url, sizeBytes: asset.sizeBytes, sha256: asset.sha256, contentVersion: asset.contentVersion });
  })
);

/**
 * Manifeste de téléchargement : journée, trimestre ou année complète d'une classe.
 * L'app compare les versions avec son stock local et ne télécharge que ce qui a changé.
 */
const manifestSchema = z.object({
  scope: z.enum(["day", "term", "year"]),
  classLevel: z.enum(ALL_CLASS_LEVELS),
  date: z.string().refine(isLocalDate).optional(),
  term: z.number().int().min(1).max(3).optional(),
  subjects: z.array(z.string().max(40)).max(20).optional(),
  includeFiles: z.boolean().default(false),
});

libraryRouter.post(
  "/manifest",
  validate(manifestSchema),
  ah(async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const body = req.body as z.infer<typeof manifestSchema>;
    const profile = await TeacherProfile.findOne({ userId }).lean();
    const assignment = profile?.assignments.find((a) => a.classLevel === body.classLevel);
    if (!profile || !assignment) throw badRequest("CLASS_NOT_ASSIGNED", "Cette classe ne fait pas partie de ton profil");
    const subjects = body.subjects?.length ? body.subjects.filter((s) => assignment.subjects.includes(s)) : assignment.subjects;

    let nodeFilter: Record<string, unknown> = { classLevel: body.classLevel, subjectCode: { $in: subjects }, kind: "lesson" };
    if (body.scope === "day") {
      if (!body.date) throw badRequest("DATE_REQUIRED", "Date requise");
      const ids = await LessonInstance.distinct("nodeId", { teacherId: userId, classLevel: body.classLevel, date: body.date });
      nodeFilter = { _id: { $in: ids } };
    } else if (body.scope === "term") {
      if (!body.term) throw badRequest("TERM_REQUIRED", "Trimestre requis");
      nodeFilter.term = body.term;
    }
    const nodeIds = await CurriculumNode.distinct("_id", nodeFilter);
    const resources = await Resource.find({ nodeId: { $in: nodeIds }, status: "PUBLISHED" })
      .select("_id type title nodeId contentVersion contentBytes assets.pdf.sizeBytes assets.pdf.contentVersion")
      .lean();
    const items = resources.map((r) => {
      const jsonBytes = r.contentBytes ?? 0;
      const pdfBytes = r.assets?.pdf?.contentVersion === r.contentVersion ? r.assets.pdf.sizeBytes ?? 0 : 0;
      return { id: String(r._id), type: r.type, title: r.title, nodeId: String(r.nodeId), contentVersion: r.contentVersion, jsonBytes, pdfBytes };
    });
    const totalBytes = items.reduce((s, i) => s + i.jsonBytes + (body.includeFiles ? i.pdfBytes : 0), 0);
    const cal = await getCalendar(profile.schoolYear);
    res.json({
      scope: body.scope,
      classLevel: body.classLevel,
      generatedAt: new Date().toISOString(),
      calendar: cal ? { startsOn: cal.startsOn, endsOn: cal.endsOn, breaks: cal.breaks } : null,
      items,
      totalBytes,
    });
  })
);

/** Ressources de remédiation liées à la compétence d'une leçon. */
libraryRouter.get(
  "/nodes/:nodeId/remediation",
  ah(async (req, res) => {
    const node = await CurriculumNode.findById(req.params.nodeId).select("parentId").lean();
    if (!node) throw notFound();
    const siblings = await CurriculumNode.distinct("_id", { parentId: node.parentId });
    const items = await Resource.find({ nodeId: { $in: [node._id, ...siblings] }, status: "PUBLISHED", type: { $in: ["remediation", "exercises"] } })
      .select(LIST_FIELDS)
      .limit(20)
      .lean();
    res.json(items.map(({ _id, ...r }) => ({ id: String(_id), ...r })));
  })
);

