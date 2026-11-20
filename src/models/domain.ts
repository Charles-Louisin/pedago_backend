/** Référentiel du primaire camerounais : deux sous-systèmes, six classes chacun, trois niveaux. */
export const SUBSYSTEMS = ["francophone", "anglophone"] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

export const CLASS_LEVELS = {
  francophone: ["SIL", "CP", "CE1", "CE2", "CM1", "CM2"],
  anglophone: ["CLASS_1", "CLASS_2", "CLASS_3", "CLASS_4", "CLASS_5", "CLASS_6"],
} as const;
export const ALL_CLASS_LEVELS = [...CLASS_LEVELS.francophone, ...CLASS_LEVELS.anglophone] as const;
export type ClassLevel = (typeof ALL_CLASS_LEVELS)[number];

export const CLASS_LABELS: Record<ClassLevel, string> = {
  SIL: "SIL",
  CP: "CP",
  CE1: "CE1",
  CE2: "CE2",
  CM1: "CM1",
  CM2: "CM2",
  CLASS_1: "Class One",
  CLASS_2: "Class Two",
  CLASS_3: "Class Three",
  CLASS_4: "Class Four",
  CLASS_5: "Class Five",
  CLASS_6: "Class Six",
};

/** Niveau I, II, III : regroupement de deux classes. */
export function stageOf(level: ClassLevel): 1 | 2 | 3 {
  const idx = (CLASS_LEVELS.francophone as readonly string[]).indexOf(level);
  const i = idx >= 0 ? idx : (CLASS_LEVELS.anglophone as readonly string[]).indexOf(level);
  return (Math.floor(i / 2) + 1) as 1 | 2 | 3;
}

export function subsystemOf(level: ClassLevel): Subsystem {
  return (CLASS_LEVELS.francophone as readonly string[]).includes(level) ? "francophone" : "anglophone";
}

export const RESOURCE_TYPES = [
  "lesson_plan",
  "course_notes",
  "written_trace",
  "exercises",
  "answer_key",
  "assessment",
  "composition",
  "exam",
  "grading_rubric",
  "illustration",
  "remediation",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const DIFFICULTIES = ["easy", "standard", "advanced"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const ILLUSTRATION_LEVELS = ["simple", "standard", "detailed"] as const;
export type IllustrationLevel = (typeof ILLUSTRATION_LEVELS)[number];

/** Cycle éditorial : aucune ressource IA n'atteint PUBLISHED sans passage par HUMAN_REVIEW → APPROVED. */
export const RESOURCE_STATUSES = ["DRAFT", "AI_CHECKED", "HUMAN_REVIEW", "APPROVED", "PUBLISHED", "REJECTED", "ARCHIVED"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const STATUS_TRANSITIONS: Record<ResourceStatus, ResourceStatus[]> = {
  DRAFT: ["AI_CHECKED", "HUMAN_REVIEW", "ARCHIVED"],
  AI_CHECKED: ["HUMAN_REVIEW", "DRAFT", "ARCHIVED"],
  HUMAN_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["PUBLISHED", "HUMAN_REVIEW"],
  PUBLISHED: ["ARCHIVED"],
  REJECTED: ["DRAFT", "ARCHIVED"],
  ARCHIVED: [],
};

export const LESSON_STATUSES = ["planned", "done", "partial", "missed", "rescheduled", "cancelled"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
