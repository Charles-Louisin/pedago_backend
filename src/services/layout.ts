import { z } from "zod";

/**
 * Modèle de mise en page d'une fiche de préparation, relevé sur la fiche de l'enseignant (PDF ou photo) :
 * titre, champs d'en-tête dans son ordre, rubriques dans son ordre avec SES intitulés, colonnes du tableau
 * de déroulement. L'aperçu dans l'app et le PDF suivent ce modèle.
 */
export const HEADER_FIELDS = ["teacher", "school", "class", "subject", "date", "time", "duration", "lesson", "level", "effectif", "other"] as const;
export const SECTION_KEYS = ["competency", "objectives", "prerequisites", "materials", "steps", "writtenTrace", "exercises", "assessment", "notes", "extra"] as const;
export const STEP_COLUMNS = ["name", "durationMin", "teacherActivities", "learnerActivities", "observations"] as const;

export const prepLayoutSchema = z.object({
  title: z.string().trim().max(120).nullish(),
  header: z.array(z.object({ label: z.string().trim().min(1).max(60), field: z.enum(HEADER_FIELDS) })).max(16).optional(),
  sections: z.array(z.object({ key: z.enum(SECTION_KEYS), label: z.string().trim().min(1).max(120) })).max(20).optional(),
  stepColumns: z.array(z.object({ key: z.enum(STEP_COLUMNS), label: z.string().trim().min(1).max(60) })).min(2).max(6).optional(),
});
export type PrepLayout = z.infer<typeof prepLayoutSchema>;
export type HeaderField = (typeof HEADER_FIELDS)[number];

/* ───────── Repérage sans IA, dans le texte d'un PDF ───────── */

const HEADER_HINTS: [HeaderField, RegExp][] = [
  ["teacher", /^(nom de l'?enseignant|enseignante?|ma[iî]tre(sse)?|teacher)\b/i],
  ["school", /^([ée]cole|[ée]tablissement|school)\b/i],
  ["class", /^(classe|niveau scolaire|class)\b/i],
  ["subject", /^(discipline|mati[èe]re|subject)\b/i],
  ["date", /^(date)\b/i],
  ["time", /^(heure|horaire|time)\b/i],
  ["duration", /^(dur[ée]e|duration)\b/i],
  ["lesson", /^(titre de la le[çc]on|le[çc]on|th[èe]me|lesson)\b/i],
  ["effectif", /^(effectif)\b/i],
];
const SECTION_HINTS: [(typeof SECTION_KEYS)[number], RegExp][] = [
  ["competency", /^(comp[ée]tences?( vis[ée]es?)?|competenc(e|y))\b/i],
  ["objectives", /^(objectifs?( sp[ée]cifiques?| p[ée]dagogiques?)?|objectives?)\b/i],
  ["prerequisites", /^(pr[ée]requis|pr[ée]-requis|prerequisites?)\b/i],
  ["materials", /^(mat[ée]riels?( didactiques?)?|supports?|materials?)\b/i],
  ["steps", /^(d[ée]roulement|d[ée]marche|[ée]tapes|phases|procedure|steps)\b/i],
  ["writtenTrace", /^(trace [ée]crite|r[ée]sum[ée]|synth[èe]se|je retiens|summary)\b/i],
  ["exercises", /^(exercices?( d'application)?|application|exercises?)\b/i],
  ["assessment", /^([ée]valuation|contr[ôo]le|assessment)\b/i],
  ["notes", /^(notes?|remarques?|observations?|rem[ée]diation)\b/i],
];
const COLUMN_HINTS: [(typeof STEP_COLUMNS)[number], RegExp][] = [
  ["name", /(^|\s)([ée]tapes?|phases?|moments?)(\s|$)/i],
  ["durationMin", /(dur[ée]e|temps|timing)/i],
  ["teacherActivities", /(activit[ée]s? (du ma[iî]tre|de l'?enseignant|enseignant)|r[ôo]le du ma[iî]tre)/i],
  ["learnerActivities", /(activit[ée]s? (des [ée]l[èe]ves|des apprenants|apprenants?)|r[ôo]le des [ée]l[èe]ves)/i],
  ["observations", /(observations?|remarques?)/i],
];

const clean = (l: string) => l.replace(/^[#*\s\d.)IVX-]+(?=[A-Za-zÀ-ÿ])/, "").replace(/\s*:.*$/, "").trim();

/** Relève titre, en-tête, rubriques et colonnes dans l'ordre du document, avec ses intitulés. */
export function detectLayout(text: string): PrepLayout | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const layout: Required<Pick<PrepLayout, "header" | "sections">> & PrepLayout = { header: [], sections: [] };
  const seenH = new Set<string>();
  const seenS = new Set<string>();
  for (const [i, line] of lines.entries()) {
    if (i < 3 && !layout.title && /fiche|pr[ée]paration|lesson plan/i.test(line) && line.length < 60) layout.title = line.replace(/\s*:.*$/, "");
    const label = clean(line);
    if (!label || label.length > 60) continue;
    const h = HEADER_HINTS.find(([, re]) => re.test(label));
    if (h && /:/.test(line) && !seenH.has(h[0])) {
      seenH.add(h[0]);
      layout.header.push({ label, field: h[0] });
      continue;
    }
    const s = SECTION_HINTS.find(([, re]) => re.test(label));
    if (s && !seenS.has(s[0]) && (!/:/.test(line) || line.split(":")[1].trim().length < 120)) {
      seenS.add(s[0]);
      layout.sections.push({ key: s[0], label });
    }
    // En-tête de tableau de déroulement : plusieurs intitulés de colonnes sur la même ligne.
    if (!layout.stepColumns) {
      const cols = COLUMN_HINTS.filter(([, re]) => re.test(line));
      if (cols.length >= 3) layout.stepColumns = cols.map(([key, re]) => ({ key, label: (line.match(re)?.[0] ?? key).trim().replace(/^\w/, (c) => c.toUpperCase()) }));
    }
  }
  if (!layout.sections.length && !layout.header.length) return null;
  return prepLayoutSchema.parse(layout);
}
