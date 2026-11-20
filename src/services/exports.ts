import PDFDocument from "pdfkit";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import crypto from "node:crypto";
import { CurriculumNode, GeneratedDocument, Resource, SourceDocument, TeacherPrep, CLASS_LABELS, type ClassLevel } from "../models/index.js";
import { lessonContentSchema, type LessonContent } from "./content-schema.js";
import { storeFile } from "./storage.js";

const TYPE_LABELS: Record<string, string> = {
  lesson_plan: "Fiche de préparation",
  course_notes: "Notes de cours",
  written_trace: "Trace écrite",
  exercises: "Exercices",
  answer_key: "Corrigé",
  assessment: "Évaluation",
  composition: "Composition",
  exam: "Épreuve d'examen",
  grading_rubric: "Grille de correction",
  illustration: "Illustrations",
  remediation: "Remédiation",
};

type Doc = {
  title: string;
  type: string;
  classLevel: string;
  subjectCode: string;
  difficulty: string;
  contentVersion: number;
  content: LessonContent;
  sources: string[];
  /** En-tête de fiche : paires libellé / valeur (enseignant, école, date…). */
  meta?: [string, string][];
  includeAnswers?: boolean;
  /** Remarques personnelles de l'enseignant. */
  remarks?: string;
};

function sections(d: Doc) {
  const c = d.content;
  const out: { heading: string; lines?: string[]; table?: string[][] }[] = [];
  if (c.competency) out.push({ heading: "Compétence visée", lines: [c.competency] });
  if (c.objectives.length) out.push({ heading: "Objectifs pédagogiques", lines: c.objectives.map((o) => `• ${o}`) });
  if (c.prerequisites.length) out.push({ heading: "Prérequis", lines: c.prerequisites.map((o) => `• ${o}`) });
  if (c.materials.length) out.push({ heading: "Matériel didactique", lines: c.materials.map((o) => `• ${o}`) });
  if (c.steps.length)
    out.push({
      heading: "Déroulement",
      table: [
        ["Étape", "Durée", "Activités de l'enseignant", "Activités des apprenants"],
        ...c.steps.map((s) => [s.name, `${s.durationMin} min`, s.teacherActivities.join("\n"), s.learnerActivities.join("\n")]),
      ],
    });
  if (c.writtenTrace) out.push({ heading: "Trace écrite", lines: [c.writtenTrace] });
  if (c.body) out.push({ heading: "Contenu", lines: c.body.split("\n") });
  const item = (e: { prompt: string; points?: number; illustration?: string }, i: number) =>
    `${i + 1}. ${e.prompt}${e.points ? ` (${e.points} pts)` : ""}${e.illustration ? `\n    Illustration : ${e.illustration}` : ""}`;
  if (c.exercises.length) out.push({ heading: "Exercices d'application", lines: c.exercises.map(item) });
  if (c.assessment.length) out.push({ heading: "Évaluation", lines: c.assessment.map(item) });
  const answers = [...c.exercises, ...c.assessment];
  if (answers.length && d.includeAnswers !== false)
    out.push({ heading: "Corrigé", lines: answers.map((e, i) => `${i + 1}. ${e.answer}${e.explanation ? ` — ${e.explanation}` : ""}`) });
  if (d.remarks) out.push({ heading: "Remarques", lines: d.remarks.split("\n") });
  if (c.lowResourceAlternatives.length)
    out.push({ heading: "Sans électricité ni matériel spécialisé", lines: c.lowResourceAlternatives.map((o) => `• ${o}`) });
  if (c.largeClassTips.length) out.push({ heading: "Pour une classe nombreuse", lines: c.largeClassTips.map((o) => `• ${o}`) });
  if (d.sources.length) out.push({ heading: "Sources", lines: d.sources });
  return out;
}

/** PDF A4 imprimable en noir et blanc, économe en encre (pas d'aplats de couleur). */
function renderPdf(d: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", bufferPages: true, margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: d.title, Producer: "PEDAGO" } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const L = 56;
    const W = 483;
    pdf.font("Helvetica").fontSize(9).fillColor("#555").text((TYPE_LABELS[d.type] ?? d.type).toUpperCase(), { characterSpacing: 1 });
    pdf.moveDown(0.3).font("Helvetica-Bold").fontSize(17).fillColor("#000").text(d.title);
    pdf.font("Helvetica");
    // En-tête de fiche : cadre à deux colonnes, comme une fiche de préparation papier.
    const meta = d.meta ?? [
      ["Classe", CLASS_LABELS[d.classLevel as ClassLevel] ?? d.classLevel],
      ["Durée", d.content.generalInfo?.durationMin ? `${d.content.generalInfo.durationMin} min` : "—"],
    ];
    const rows = Math.ceil(meta.length / 2);
    const top = pdf.y + 10;
    const rowH = 20;
    pdf.lineWidth(0.6).strokeColor("#888").rect(L, top, W, rows * rowH).stroke();
    meta.forEach(([k, v], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = L + col * (W / 2);
      const y = top + row * rowH;
      if (row > 0 && col === 0) pdf.moveTo(L, y).lineTo(L + W, y).stroke();
      pdf.fontSize(8.5).fillColor("#555").text(`${k} :`, x + 6, y + 6, { width: 70, lineBreak: false });
      pdf.fontSize(9.5).fillColor("#000").text(v || "—", x + 74, y + 5.5, { width: W / 2 - 80, height: rowH - 4, ellipsis: true, lineBreak: false });
    });
    if (meta.length > 1) pdf.moveTo(L + W / 2, top).lineTo(L + W / 2, top + rows * rowH).stroke();
    pdf.x = L;
    pdf.y = top + rows * rowH + 18;

    for (const s of sections(d)) {
      // Pas de titre seul en bas de page : il part avec son contenu.
      if (pdf.y > 700) pdf.addPage();
      pdf.fontSize(12).fillColor("#000").text(s.heading.toUpperCase(), { characterSpacing: 0.6 });
      pdf.moveDown(0.3).fontSize(10.5);
      for (const line of s.lines ?? []) pdf.text(line, { paragraphGap: 2 });
      if (s.table) {
        // Tableau à colonnes avec retour à la ligne et saut de page propre.
        const widths = [92, 44, 173.5, 173.5];
        for (const [i, row] of s.table.entries()) {
          pdf.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9);
          const h = Math.max(...row.map((cell, c) => pdf.heightOfString(cell || " ", { width: widths[c] - 8 }))) + 8;
          if (pdf.y + h > 780) pdf.addPage();
          const y = pdf.y;
          let x = 56;
          row.forEach((cell, c) => {
            if (i === 0) pdf.rect(x, y, widths[c], h).fillAndStroke("#EEEEEE", "#888").fillColor("#000");
            else pdf.rect(x, y, widths[c], h).stroke("#888");
            pdf.text(cell, x + 4, y + 4, { width: widths[c] - 8 });
            x += widths[c];
          });
          pdf.x = 56;
          pdf.y = y + h;
        }
        pdf.font("Helvetica").fontSize(10.5);
      }
      pdf.moveDown(0.8);
    }
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      // Pied de page dans la marge basse : la marge est levée le temps d'écrire, sinon une page vide est créée.
      pdf.page.margins.bottom = 0;
      pdf.fontSize(8).fillColor("#666").text(`PEDAGO — page ${i + 1}/${range.count}`, 56, 805, { align: "center", width: 483, lineBreak: false });
    }
    pdf.end();
  });
}

async function renderDocx(d: Doc): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ children: [new TextRun({ text: `${TYPE_LABELS[d.type] ?? d.type} · ${d.classLevel} · ${d.subjectCode}`, size: 18, color: "555555" })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(d.title)] }),
    ...(d.meta?.length
      ? [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: d.meta.map(
              ([k, v]) =>
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: k, bold: true })] })] }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun(v || "—")] })] }),
                  ],
                })
            ),
          }),
        ]
      : []),
  ];
  for (const s of sections(d)) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(s.heading)] }));
    for (const line of s.lines ?? []) children.push(new Paragraph({ children: [new TextRun(line)] }));
    if (s.table) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: s.table.map(
            (row, i) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: cell.split("\n").map((t) => new Paragraph({ children: [new TextRun({ text: t, bold: i === 0 })] })),
                    })
                ),
              })
          ),
        })
      );
    }
  }
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Généré par PEDAGO", size: 16, color: "777777" })] }));
  const doc = new Document({ creator: "PEDAGO", title: d.title, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/** Génère l'export une seule fois par version de contenu, puis le réutilise pour tous les enseignants. */
const inFlight = new Map<string, Promise<unknown>>();

/** Plusieurs enseignants demandant le même export en même temps partagent une seule génération. */
export function ensureExport(resourceId: string, format: "pdf" | "docx") {
  const key = resourceId + ":" + format;
  let p = inFlight.get(key) as ReturnType<typeof generateExport> | undefined;
  if (!p) {
    p = generateExport(resourceId, format).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function generateExport(resourceId: string, format: "pdf" | "docx") {
  const r = await Resource.findById(resourceId);
  if (!r || r.status !== "PUBLISHED") return null;
  const existing = r.assets?.[format];
  if (existing?.url && existing.contentVersion === r.contentVersion) return existing;

  const sources = await SourceDocument.find({ _id: { $in: r.sources.map((s) => s.sourceId) } }).select("title issuer url").lean();
  const doc: Doc = {
    title: r.title,
    type: r.type,
    classLevel: r.classLevel,
    subjectCode: r.subjectCode,
    difficulty: r.difficulty,
    contentVersion: r.contentVersion,
    content: lessonContentSchema.parse(r.content),
    sources: sources.map((s) => `${s.issuer} — ${s.title}${s.url ? ` (${s.url})` : ""}`),
  };
  const data = format === "pdf" ? await renderPdf(doc) : await renderDocx(doc);
  const slug = r.title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const stored = await storeFile(
    `${slug}-v${r.contentVersion}.${format}`,
    data,
    format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  const asset = { ...stored, generatedAt: new Date(), contentVersion: r.contentVersion };
  await Resource.updateOne({ _id: r._id }, { [`assets.${format}`]: asset });
  return asset;
}


const SUBJECT_LABELS: Record<string, string> = {
  MATH: "Mathématiques", FR: "Français", SCI: "Sciences et technologie", SHS: "Sciences humaines et sociales", EN: "Anglais",
  LCN: "Langues et cultures nationales", ART: "Éducation artistique", EPS: "EPS", TIC: "TIC",
  ENG: "English Language", SOC: "Social Studies", FRE: "French", NLC: "National Languages and Cultures", PE: "Physical Education", ICT: "ICT",
};
const LEVEL_LABEL: Record<string, string> = { easy: "Facile", standard: "Standard", advanced: "Approfondi" };
const ILLU_LABEL: Record<string, string> = { simple: "Simples", standard: "Légendées", detailed: "Détaillées" };

type LessonLike = { _id: unknown; nodeId: unknown; classLevel: string; subjectCode: string; date: string; start?: string | null; end?: string | null };

/**
 * Document de séance : la fiche de l'enseignant prime ; la bibliothèque complète ce qui manque
 * (variante la plus proche du niveau et des illustrations demandés).
 */
export async function buildLessonDocument(o: {
  teacherId: string;
  teacherName: string;
  schoolName: string;
  lesson: LessonLike;
  difficulty: string;
  illustrationLevel: string;
  includeAnswers: boolean;
  format: "pdf" | "docx";
}) {
  const node = await CurriculumNode.findById(o.lesson.nodeId).lean();
  if (!node) throw new Error("Leçon introuvable");
  const officialId = node.ownerId ? node.matchedNodeId : node._id;
  const [library, prep] = await Promise.all([
    officialId
      ? Resource.find({ nodeId: officialId, status: "PUBLISHED", type: { $in: ["lesson_plan", "exercises", "assessment"] } }).lean()
      : Promise.resolve([]),
    TeacherPrep.findOne({ teacherId: o.teacherId, nodeId: node._id }).lean(),
  ]);
  const score = (r: { difficulty: string; illustrationLevel: string }) =>
    (r.difficulty === o.difficulty ? 4 : r.difficulty === "standard" ? 2 : 0) + (r.illustrationLevel === o.illustrationLevel ? 1 : 0);
  const best = (type: string) => library.filter((r) => r.type === type).sort((a, b) => score(b) - score(a))[0];
  const plan = best("lesson_plan");
  const exo = best("exercises");
  const evalRes = best("assessment");

  const base = lessonContentSchema.parse(plan?.content ?? { generalInfo: { durationMin: node.durationMin ?? 45 }, objectives: node.objectives ?? [] });
  if (!base.exercises.length && exo) base.exercises = lessonContentSchema.parse(exo.content).exercises;
  if (!base.assessment.length && evalRes) base.assessment = lessonContentSchema.parse(evalRes.content).assessment;

  // La fiche de l'enseignant remplace les rubriques qu'il a remplies.
  const p = (prep?.content ?? {}) as {
    objectives?: string[]; materials?: string[]; writtenTrace?: string; notes?: string;
    steps?: LessonContent["steps"]; exercises?: { prompt: string; answer: string }[];
  };
  if (p.objectives?.length) base.objectives = p.objectives;
  if (p.materials?.length) base.materials = p.materials;
  if (p.steps?.length) base.steps = p.steps;
  if (p.writtenTrace) base.writtenTrace = p.writtenTrace;
  if (p.exercises?.length) base.exercises = p.exercises.map((e) => ({ prompt: e.prompt, answer: e.answer || "—" }));
  if (base.body?.startsWith("CONTENU DE DÉMONSTRATION")) base.body = undefined;

  // Niveau d'illustration : « simples » retire les descriptions d'images, les autres les gardent.
  if (o.illustrationLevel === "simple") {
    base.exercises = base.exercises.map(({ illustration: _i, ...e }) => e);
    base.assessment = base.assessment.map(({ illustration: _i, ...e }) => e);
  }
  if (!o.includeAnswers) {
    base.exercises = base.exercises.map((e) => ({ ...e, answer: "", explanation: undefined }));
    base.assessment = base.assessment.map((e) => ({ ...e, answer: "", explanation: undefined }));
  }

  const [y, m, dd] = o.lesson.date.split("-");
  const doc: Doc = {
    title: node.title,
    type: "lesson_plan",
    classLevel: o.lesson.classLevel,
    subjectCode: o.lesson.subjectCode,
    difficulty: o.difficulty,
    contentVersion: 1,
    content: base,
    includeAnswers: o.includeAnswers,
    remarks: p.notes,
    sources: plan ? [`Bibliothèque PEDAGO${plan.approvedAt ? " (validée)" : ""}`] : [],
    meta: [
      ["Enseignant", o.teacherName],
      ["École", o.schoolName],
      ["Classe", CLASS_LABELS[o.lesson.classLevel as ClassLevel] ?? o.lesson.classLevel],
      ["Discipline", SUBJECT_LABELS[o.lesson.subjectCode] ?? o.lesson.subjectCode],
      ["Date", `${dd}/${m}/${y}`],
      ["Horaire", o.lesson.start ? `${o.lesson.start} – ${o.lesson.end}` : "—"],
      ["Durée", `${base.generalInfo?.durationMin ?? node.durationMin ?? 45} min`],
      ["Niveau", `${LEVEL_LABEL[o.difficulty] ?? o.difficulty} · illustrations ${(ILLU_LABEL[o.illustrationLevel] ?? o.illustrationLevel).toLowerCase()}`],
    ],
  };
  const data = o.format === "pdf" ? await renderPdf(doc) : await renderDocx(doc);
  const slug = node.title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  // Nom imprévisible : la fiche personnelle n'est accessible qu'avec le lien reçu.
  const stored = await storeFile(
    `fiche-${slug}-${o.lesson.date}-${crypto.randomBytes(8).toString("hex")}.${o.format}`,
    data,
    o.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  await GeneratedDocument.create({ teacherId: o.teacherId, lessonId: o.lesson._id, url: stored.url, key: stored.key, sizeBytes: stored.sizeBytes });
  return { url: stored.url, sizeBytes: stored.sizeBytes, usedPrep: Boolean(prep), usedLibrary: Boolean(plan || exo || evalRes) };
}
