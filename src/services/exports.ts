import PDFDocument from "pdfkit";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { Resource, SourceDocument, CLASS_LABELS, type ClassLevel } from "../models/index.js";
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
  if (c.exercises.length)
    out.push({ heading: "Exercices d'application", lines: c.exercises.map((e, i) => `${i + 1}. ${e.prompt}${e.points ? ` (${e.points} pts)` : ""}`) });
  if (c.assessment.length)
    out.push({ heading: "Évaluation", lines: c.assessment.map((e, i) => `${i + 1}. ${e.prompt}${e.points ? ` (${e.points} pts)` : ""}`) });
  const answers = [...c.exercises, ...c.assessment];
  if (answers.length)
    out.push({ heading: "Corrigé", lines: answers.map((e, i) => `${i + 1}. ${e.answer}${e.explanation ? ` — ${e.explanation}` : ""}`) });
  if (c.lowResourceAlternatives.length)
    out.push({ heading: "Sans électricité ni matériel spécialisé", lines: c.lowResourceAlternatives.map((o) => `• ${o}`) });
  if (c.largeClassTips.length) out.push({ heading: "Pour une classe nombreuse", lines: c.largeClassTips.map((o) => `• ${o}`) });
  if (d.sources.length) out.push({ heading: "Sources", lines: d.sources });
  return out;
}

/** PDF A4 imprimable en noir et blanc, économe en encre (pas d'aplats de couleur). */
function renderPdf(d: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: d.title, Producer: "PEDAGO" } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    pdf.fontSize(9).fillColor("#444").text(`${TYPE_LABELS[d.type] ?? d.type} · ${CLASS_LABELS[d.classLevel as ClassLevel] ?? d.classLevel} · ${d.subjectCode} · v${d.contentVersion}`);
    pdf.moveDown(0.4).fontSize(18).fillColor("#000").text(d.title);
    if (d.content.generalInfo?.durationMin) pdf.fontSize(10).fillColor("#444").text(`Durée : ${d.content.generalInfo.durationMin} min`);
    pdf.moveTo(56, pdf.y + 6).lineTo(539, pdf.y + 6).lineWidth(0.5).strokeColor("#999").stroke();
    pdf.moveDown(1);

    for (const s of sections(d)) {
      pdf.fontSize(12).fillColor("#000").text(s.heading.toUpperCase(), { characterSpacing: 0.6 });
      pdf.moveDown(0.3).fontSize(10.5);
      for (const line of s.lines ?? []) pdf.text(line, { paragraphGap: 2 });
      if (s.table) {
        for (const [i, row] of s.table.entries()) {
          pdf.font(i === 0 ? "Helvetica-Bold" : "Helvetica").text(row.join("  |  "), { paragraphGap: 4 });
        }
        pdf.font("Helvetica");
      }
      pdf.moveDown(0.8);
    }
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf.fontSize(8).fillColor("#666").text(`PEDAGO — page ${i + 1}/${range.count}`, 56, 800, { align: "center", width: 483 });
    }
    pdf.end();
  });
}

async function renderDocx(d: Doc): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ children: [new TextRun({ text: `${TYPE_LABELS[d.type] ?? d.type} · ${d.classLevel} · ${d.subjectCode}`, size: 18, color: "555555" })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(d.title)] }),
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
  const slug = r.title.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").slice(0, 60);
  const stored = await storeFile(
    `${slug}-v${r.contentVersion}.${format}`,
    data,
    format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  const asset = { ...stored, generatedAt: new Date(), contentVersion: r.contentVersion };
  await Resource.updateOne({ _id: r._id }, { [`assets.${format}`]: asset });
  return asset;
}
