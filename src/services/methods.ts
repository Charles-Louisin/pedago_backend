import { PreparationMethod } from "../models/index.js";
import type { PrepLayout } from "./layout.js";

export type MethodDoc = {
  _id: unknown;
  title: string;
  subsystem: string;
  classLevels: string[];
  subjectCodes: string[];
  resourceTypes: string[];
  layout: PrepLayout;
  sectionGuidance: { label: string; guidance?: string }[];
  steps: { name: string; purpose?: string; durationMin?: number; teacherRole?: string; learnerRole?: string }[];
  extraSections: { label: string; guidance?: string }[];
  conventions: string[];
  status: string;
  version: number;
};

type Target = { subsystem: string; classLevel: string; subjectCode: string; type: string };

/** La méthode couvre-t-elle cette leçon ? (listes vides = toutes les classes / matières.) */
export function covers(m: Pick<MethodDoc, "subsystem" | "classLevels" | "subjectCodes" | "resourceTypes">, t: Target) {
  return (
    m.subsystem === t.subsystem &&
    (!m.classLevels.length || m.classLevels.includes(t.classLevel)) &&
    (!m.subjectCodes.length || m.subjectCodes.includes(t.subjectCode)) &&
    (m.resourceTypes.length ? m.resourceTypes : ["lesson_plan"]).includes(t.type)
  );
}

/** Précision d'une méthode pour une leçon : la matière compte plus que la classe. */
const specificity = (m: Pick<MethodDoc, "classLevels" | "subjectCodes">) => (m.subjectCodes.length ? 2 : 0) + (m.classLevels.length ? 1 : 0);

/** Méthode validée à suivre pour cette leçon (la plus précise ; à égalité, la plus récente), ou null. */
export async function methodFor(t: Target): Promise<MethodDoc | null> {
  const all = (await PreparationMethod.find({ subsystem: t.subsystem, status: "validated" }).sort({ validatedAt: -1 }).lean()) as unknown as MethodDoc[];
  const fit = all.filter((m) => covers(m, t));
  fit.sort((a, b) => specificity(b) - specificity(a));
  return fit[0] ?? null;
}

/**
 * Méthodes encore en attente de relecture qui toucheraient cette génération : tant qu'il y en a, on ne
 * génère pas (sinon les leçons partiraient avec l'ancienne démarche et il faudrait tout refaire).
 */
export async function pendingMethodsFor(t: { subsystem: string; classLevel?: string; subjectCode?: string; types: string[] }) {
  const pending = (await PreparationMethod.find({ subsystem: t.subsystem, status: "extracted" }).select("title subsystem classLevels subjectCodes resourceTypes").lean()) as unknown as MethodDoc[];
  return pending.filter(
    (m) =>
      (!t.classLevel || !m.classLevels.length || m.classLevels.includes(t.classLevel)) &&
      (!t.subjectCode || !m.subjectCodes.length || m.subjectCodes.includes(t.subjectCode)) &&
      t.types.some((type) => (m.resourceTypes.length ? m.resourceTypes : ["lesson_plan"]).includes(type))
  );
}

/** Consignes de la méthode pour le rédacteur : rubriques, démarche, conventions (texte relu et validé). */
export function methodBrief(m: MethodDoc) {
  const guidance = new Map(m.sectionGuidance.map((g) => [g.label.toLowerCase(), g.guidance]));
  const lines: string[] = [`Méthode : ${m.title}`];
  if (m.layout.header?.length) lines.push(`Cartouche : ${m.layout.header.map((h) => h.label).join(" · ")}`);
  if (m.layout.sections?.length) {
    lines.push("Rubriques, dans cet ordre et avec ces intitulés :");
    for (const s of m.layout.sections) {
      const g = guidance.get(s.label.toLowerCase());
      lines.push(`- ${s.label}${g ? ` : ${g}` : ""}`);
    }
  }
  if (m.steps.length) {
    lines.push("Étapes du déroulement (champ steps), dans cet ordre, avec ces noms exacts :");
    m.steps.forEach((s, i) =>
      lines.push(
        `${i + 1}. ${s.name}${s.durationMin ? ` (≈ ${s.durationMin} min)` : ""}${s.purpose ? ` — ${s.purpose}` : ""}${s.teacherRole ? ` · Enseignant : ${s.teacherRole}` : ""}${s.learnerRole ? ` · Apprenants : ${s.learnerRole}` : ""}`
      )
    );
  }
  if (m.extraSections.length) {
    lines.push("Rubriques propres à la méthode, à remplir dans extraSections (label = intitulé exact) :");
    for (const x of m.extraSections) lines.push(`- ${x.label}${x.guidance ? ` : ${x.guidance}` : ""}`);
  }
  if (m.conventions.length) {
    lines.push("Règles de rédaction :");
    for (const c of m.conventions) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}

/** Écarts entre les étapes rédigées et celles de la méthode (contrôle programmatique, sans IA). */
export function stepGaps(m: Pick<MethodDoc, "steps">, written: { name: string }[]) {
  if (!m.steps.length) return [];
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const want = m.steps.map((s) => norm(s.name));
  const got = written.map((s) => norm(s.name));
  const missing = m.steps.filter((s, i) => !got.some((g) => g.includes(want[i]) || want[i].includes(g)));
  return missing.map((s) => s.name);
}
