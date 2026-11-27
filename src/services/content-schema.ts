import { z } from "zod";

/**
 * Schéma du contenu structuré d'une ressource. L'IA ne peut jamais publier un JSON arbitraire :
 * toute sortie de génération est validée ici avant enregistrement.
 */
const exercise = z.object({
  prompt: z.string().min(3).max(2000),
  // Un corrigé absent ne fait pas échouer la génération (une relance coûte un nouvel appel au modèle) :
  // il est signalé comme erreur bloquante par deterministicChecks, et la relecture humaine le complète.
  answer: z.string().max(2000).nullish().transform((v) => v ?? ""),
  explanation: z.string().max(2000).optional(),
  points: z.number().min(0).max(100).optional(),
  competency: z.string().max(300).optional(),
  illustration: z.string().max(400).optional(),
});

export const lessonContentSchema = z.object({
  generalInfo: z
    .object({
      domain: z.string().max(200).optional(),
      durationMin: z.number().int().min(5).max(240),
      period: z.string().max(80).optional(),
    })
    .optional(),
  competency: z.string().max(600).optional(),
  objectives: z.array(z.string().min(3).max(400)).max(12).default([]),
  prerequisites: z.array(z.string().max(300)).max(12).default([]),
  materials: z.array(z.string().max(300)).max(20).default([]),
  /** Méthode alternative sans électricité, projecteur, imprimante… */
  lowResourceAlternatives: z.array(z.string().max(500)).max(10).default([]),
  largeClassTips: z.array(z.string().max(500)).max(10).default([]),
  steps: z
    .array(
      z.object({
        name: z.string().min(2).max(160),
        durationMin: z.number().int().min(1).max(120),
        teacherActivities: z.array(z.string().max(800)).max(15).default([]),
        learnerActivities: z.array(z.string().max(800)).max(15).default([]),
      })
    )
    .max(12)
    .default([]),
  writtenTrace: z.string().max(4000).optional(),
  exercises: z.array(exercise).max(30).default([]),
  assessment: z.array(exercise).max(30).default([]),
  localContext: z.array(z.string().max(400)).max(10).default([]),
  body: z.string().max(20000).optional(),
  /** Rubriques propres à la méthode de préparation suivie (« Méthodes et techniques »…), avec leur intitulé exact. */
  extraSections: z
    .array(z.object({ label: z.string().trim().min(1).max(120), lines: z.array(z.string().max(1500)).max(20).default([]) }))
    .max(10)
    .default([]),
});
export type LessonContent = z.infer<typeof lessonContentSchema>;

export type DeterministicIssue = { severity: "error" | "warning"; area: string; message: string };

/** Contrôles programmatiques (avant toute relecture IA ou humaine). */
export function deterministicChecks(content: LessonContent, expectedDuration?: number): DeterministicIssue[] {
  const issues: DeterministicIssue[] = [];
  const stepsTotal = content.steps.reduce((s, x) => s + x.durationMin, 0);
  const duration = content.generalInfo?.durationMin ?? expectedDuration;
  if (duration && content.steps.length && Math.abs(stepsTotal - duration) > Math.max(5, duration * 0.15)) {
    issues.push({ severity: "warning", area: "durée", message: `Les étapes totalisent ${stepsTotal} min pour une séance de ${duration} min` });
  }
  [...content.exercises, ...content.assessment].forEach((ex, i) => {
    if (!ex.answer.trim()) issues.push({ severity: "error", area: "corrigé", message: `Question ${i + 1} sans corrigé` });
    // Vérifie les opérations simples « a op b = c » présentes dans les corrigés.
    for (const m of ex.answer.matchAll(/(\d+)\s*([+\-x×*:÷/])\s*(\d+)\s*=\s*(\d+)/g)) {
      const [a, op, b, c] = [Number(m[1]), m[2], Number(m[3]), Number(m[4])];
      const r = op === "+" ? a + b : op === "-" ? a - b : "x×*".includes(op) ? a * b : b ? a / b : NaN;
      if (r !== c) issues.push({ severity: "error", area: "calcul", message: `Calcul faux dans le corrigé : ${m[0]} (attendu ${r})` });
    }
  });
  if (content.assessment.length) {
    const missing = content.assessment.filter((q) => q.points === undefined).length;
    if (missing) issues.push({ severity: "warning", area: "barème", message: `${missing} question(s) d'évaluation sans barème` });
    const noCompetency = content.assessment.filter((q) => !q.competency).length;
    if (noCompetency) issues.push({ severity: "warning", area: "compétence", message: `${noCompetency} question(s) non reliée(s) à une compétence` });
  }
  if (!content.objectives.length) issues.push({ severity: "warning", area: "objectifs", message: "Aucun objectif pédagogique" });
  // Fiche imprimée en noir et blanc, polices sans emoji : un pictogramme sortirait illisible sur le PDF.
  const emoji = /\p{Extended_Pictographic}/u;
  const texts = [content.competency, content.writtenTrace, content.body, ...content.objectives, ...content.materials, ...content.steps.flatMap((s) => [s.name, ...s.teacherActivities, ...s.learnerActivities]), ...[...content.exercises, ...content.assessment].flatMap((e) => [e.prompt, e.answer])];
  if (texts.some((t) => t && emoji.test(t))) issues.push({ severity: "error", area: "impression", message: "Emoji ou pictogramme dans le texte : à remplacer par des mots ou une illustration décrite" });
  return issues;
}
