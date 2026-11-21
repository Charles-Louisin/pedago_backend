import { z } from "zod";
import type { PrepContent } from "./prep-text.js";
import { formToContent, type PrepForm } from "./prep-text.js";

/**
 * Modèle de mise en page d'une fiche de préparation, relevé sur la fiche de l'enseignant (PDF ou photo) :
 * titre, cartouche (champs et valeurs d'origine), rubriques dans son ordre avec SES intitulés, colonnes du
 * tableau, style (police, alignement, mise en forme des intitulés, couleur) et images d'en-tête (logos,
 * armoiries). L'aperçu dans l'app et le PDF suivent ce modèle.
 */
export const HEADER_FIELDS = ["teacher", "school", "class", "subject", "date", "time", "duration", "lesson", "level", "effectif", "other"] as const;
export const SECTION_KEYS = ["competency", "objectives", "prerequisites", "materials", "steps", "writtenTrace", "exercises", "assessment", "notes", "extra"] as const;
export const STEP_COLUMNS = ["name", "durationMin", "teacherActivities", "learnerActivities", "observations"] as const;

export const prepStyleSchema = z.object({
  font: z.enum(["sans", "serif", "script", "mono"]).default("sans"),
  titleAlign: z.enum(["left", "center"]).default("left"),
  headingUppercase: z.boolean().default(true),
  headingBold: z.boolean().default(false),
  headingUnderline: z.boolean().default(false),
  /** Couleur d'encre des intitulés (#RRGGBB), noir si absente. */
  ink: z.string().regex(/^#[0-9a-f]{6}$/i).nullish(),
});
export type PrepStyle = z.infer<typeof prepStyleSchema>;

export const prepLayoutSchema = z.object({
  title: z.string().trim().max(120).nullish(),
  header: z.array(z.object({ label: z.string().trim().min(1).max(60), field: z.enum(HEADER_FIELDS), value: z.string().trim().max(120).nullish() })).max(16).optional(),
  sections: z.array(z.object({ key: z.enum(SECTION_KEYS), label: z.string().trim().min(1).max(120) })).max(20).optional(),
  stepColumns: z.array(z.object({ key: z.enum(STEP_COLUMNS), label: z.string().trim().min(1).max(60) })).min(2).max(6).optional(),
  style: prepStyleSchema.nullish(),
  /** Images d'en-tête recadrées sur l'original (logo d'école, armoiries…), avec leur position. */
  images: z.array(z.object({ url: z.string().url().max(500), position: z.enum(["left", "center", "right"]), widthPct: z.number().min(5).max(60) })).max(3).optional(),
});
export type PrepLayout = z.infer<typeof prepLayoutSchema>;
export type HeaderField = (typeof HEADER_FIELDS)[number];

/* ───────── Lecture sans IA, dans le texte d'un PDF ───────── */

const HEADER_HINTS: [HeaderField, RegExp][] = [
  ["teacher", /^(nom de l'?enseignant(e)?|enseignant(e)?|ma[iî]tre(sse)?|teacher)$/i],
  ["school", /^([ée]cole|[ée]tablissement|school)$/i],
  ["class", /^(classe|niveau scolaire|class)$/i],
  ["subject", /^(discipline|mati[èe]re|subject)$/i],
  ["date", /^(date)$/i],
  ["time", /^(heure|horaire|time)$/i],
  ["duration", /^(dur[ée]e|duration)$/i],
  ["lesson", /^(titre de la le[çc]on|le[çc]on|titre|lesson)$/i],
  ["effectif", /^(effectifs?)$/i],
];
// Intitulé de rubrique : le mot-clé, suivi éventuellement d'un qualificatif court (« Objectif spécifique »).
const SECTION_HINTS: [(typeof SECTION_KEYS)[number], RegExp][] = [
  ["competency", /^comp[ée]tences?\b/i],
  ["objectives", /^objectifs?\b/i],
  ["prerequisites", /^(pr[ée]requis|pr[ée]-requis)\b/i],
  ["materials", /^(mat[ée]riels?|supports?)\b/i],
  ["steps", /^(d[ée]roulement|d[ée]marche|[ée]tapes de la le[çc]on|phases)\b/i],
  ["writtenTrace", /^(trace [ée]crite|r[ée]sum[ée]|synth[èe]se|je retiens|retenons)\b/i],
  ["exercises", /^(exercices?|application)\b/i],
  ["assessment", /^([ée]valuation|contr[ôo]le)\b/i],
  ["notes", /^(notes?|remarques?|observations?|rem[ée]diation)\b/i],
];
const COLUMN_HINTS: [(typeof STEP_COLUMNS)[number], RegExp][] = [
  ["name", /([ée]tapes?|phases?|moments?)/i],
  ["durationMin", /(dur[ée]e|temps|timing)/i],
  ["teacherActivities", /(activit[ée]s? (du ma[iî]tre|de l'?enseignant|enseignant)|r[ôo]le du ma[iî]tre)/i],
  ["learnerActivities", /(activit[ée]s? (des [ée]l[èe]ves|des apprenants|apprenants?)|r[ôo]le des [ée]l[èe]ves)/i],
  ["observations", /(observations?|remarques?)/i],
];

const STEP_LINE = /\(\s*\d{1,3}\s*(min|mn|')/i;
const stripBullet = (l: string) => l.replace(/^(?:[-*•–·]\s*|\d+[.)]\s*|[IVX]+[.)]\s*)+/, "").trim();

/**
 * Lit une fiche tapée (texte d'un PDF) : contenu ET modèle, en un passage.
 * - « Libellé : valeur » en tête = cartouche (valeur d'origine gardée) ;
 * - intitulé de rubrique (avec ou sans qualificatif, seul ou suivi de « : ») = nouvelle rubrique ;
 * - ligne d'en-tête du tableau de déroulement = colonnes (pas une étape) ;
 * - intitulé inconnu terminé par « : » = rubrique propre à l'enseignant.
 */
export function parsePrepText(text: string): { content: PrepContent; layout: PrepLayout | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const layout: { title?: string; header: NonNullable<PrepLayout["header"]>; sections: NonNullable<PrepLayout["sections"]>; stepColumns?: PrepLayout["stepColumns"] } = { header: [], sections: [] };
  const form: PrepForm = { objectives: "", materials: "", steps: "", writtenTrace: "", exercises: "", notes: "" };
  const extra: { label: string; lines: string[] }[] = [];
  const FORM_KEY: Record<string, keyof PrepForm | null> = { objectives: "objectives", materials: "materials", steps: "steps", writtenTrace: "writtenTrace", exercises: "exercises", assessment: "exercises", notes: "notes", competency: null, prerequisites: null };
  let current: { kind: "form"; key: keyof PrepForm } | { kind: "extra"; index: number } | null = null;
  const push = (value: string) => {
    if (!value) return;
    if (!current) current = { kind: "form", key: "notes" };
    if (current.kind === "form") form[current.key] += (form[current.key] ? "\n" : "") + value;
    else extra[current.index].lines.push(stripBullet(value));
  };
  const seenS = new Set<string>();
  let sectionsStarted = false;

  for (const [i, line] of lines.entries()) {
    if (i < 3 && !layout.title && /fiche|pr[ée]paration|lesson plan/i.test(line) && !line.includes(":") && line.length < 60) {
      layout.title = line;
      continue;
    }
    const colon = line.indexOf(":");
    const label = stripBullet(colon > 0 ? line.slice(0, colon) : line).replace(/\s+/g, " ");
    const after = colon > 0 ? line.slice(colon + 1).trim() : "";

    // Ligne d'en-tête du tableau : plusieurs intitulés de colonnes sur la même ligne.
    const cols = COLUMN_HINTS.filter(([, re]) => re.test(line));
    if (cols.length >= 3 && !STEP_LINE.test(line)) {
      layout.stepColumns ??= cols.map(([key, re]) => ({ key, label: (line.match(re)?.[0] ?? key).trim().replace(/^\w/, (c) => c.toUpperCase()) }));
      continue;
    }

    // Cartouche : champs « Libellé : valeur » avant les rubriques.
    const h = colon > 0 ? HEADER_HINTS.find(([, re]) => re.test(label)) : undefined;
    if (h && !sectionsStarted) {
      layout.header.push({ label, field: h[0], value: after || null });
      continue;
    }

    // Rubrique : mot-clé + qualificatif court, seul sur sa ligne ou suivi de « : ».
    const s = label.length <= 40 && !STEP_LINE.test(line) ? SECTION_HINTS.find(([, re]) => re.test(label)) : undefined;
    if (s && !seenS.has(label.toLowerCase())) {
      seenS.add(label.toLowerCase());
      sectionsStarted = true;
      const formKey = FORM_KEY[s[0]];
      if (formKey) {
        layout.sections.push({ key: s[0], label });
        current = { kind: "form", key: formKey };
      } else {
        layout.sections.push({ key: "extra", label });
        extra.push({ label, lines: [] });
        current = { kind: "extra", index: extra.length - 1 };
      }
      push(after);
      continue;
    }

    // Champ libre en tête (« Domaine : Mathématiques ») : gardé tel quel dans le cartouche.
    if (colon > 0 && !sectionsStarted && label.length <= 25 && label.split(" ").length <= 3 && after) {
      layout.header.push({ label, field: "other", value: after });
      continue;
    }
    // Intitulé inconnu terminé par « : » (« Méthode : ») = rubrique propre à l'enseignant.
    if (colon === line.length - 1 && label.length <= 40) {
      sectionsStarted = true;
      layout.sections.push({ key: "extra", label });
      extra.push({ label, lines: [] });
      current = { kind: "extra", index: extra.length - 1 };
      continue;
    }
    push(line);
  }

  const content = formToContent(form);
  const extras = extra.filter((x) => x.lines.length);
  if (extras.length) content.extra = extras;
  const parsed = prepLayoutSchema.safeParse({ ...layout, header: layout.header.length ? layout.header : undefined });
  return { content, layout: layout.sections.length || layout.header.length ? (parsed.success ? parsed.data : null) : null };
}

/** Compatibilité : modèle seul. */
export function detectLayout(text: string): PrepLayout | null {
  return parsePrepText(text).layout;
}
