import mongoose, { Schema } from "mongoose";
import { LESSON_STATUSES } from "./domain.js";

const HHMM = /^\d{2}:\d{2}$/;
const slotSchema = new Schema({
  weekday: { type: Number, min: 1, max: 7, required: true },
  start: { type: String, match: HHMM, required: true },
  end: { type: String, match: HHMM, required: true },
  subjectCode: { type: String, required: true },
  room: { type: String, maxlength: 80 },
  /** Intitulé tel qu'écrit sur le document de l'enseignant (« Lecture / Écriture »). */
  label: { type: String, maxlength: 120 },
});
const extraSchema = new Schema(
  {
    weekday: { type: Number, min: 1, max: 7, required: true },
    start: { type: String, match: HHMM, required: true },
    end: { type: String, match: HHMM, required: true },
    kind: { type: String, enum: ["break", "special"], required: true },
    label: { type: String, maxlength: 120, required: true },
  },
  { _id: false }
);
const historySchema = new Schema(
  {
    version: Number,
    source: String,
    importId: Schema.Types.ObjectId,
    slots: [{ _id: false, weekday: Number, start: String, end: String, subjectCode: String, room: String, label: String }],
    extras: [extraSchema],
    savedAt: Date,
  },
  { _id: false }
);
/** Nombre de versions précédentes conservées par emploi du temps. */
export const TIMETABLE_HISTORY_MAX = 20;

/**
 * Emploi du temps hebdomadaire VERSIONNÉ : heures locales « HH:mm », jour 1 (lundi) à 6 (samedi).
 * Chaque enregistrement (saisie, import validé, proposition acceptée) incrémente `version` et range l'état
 * précédent dans `history` : un document par classe et par année, pas de collection d'historique à part.
 */
const timetableSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    classLevel: { type: String, required: true },
    schoolYear: { type: String, required: true },
    /** Créneaux d'enseignement : seuls eux reçoivent des leçons de la progression. */
    slots: [slotSchema],
    /** Pauses et séances particulières (récréation, cérémonie des couleurs…) : affichées, jamais planifiées. */
    extras: [extraSchema],
    version: { type: Number, default: 1 },
    /** Origine de la version en cours. « proposal » : répartition PROPOSÉE, ce n'est pas l'emploi du temps officiel. */
    source: { type: String, enum: ["manual", "import", "proposal"], default: "manual" },
    /** Import validé à l'origine de cette version. */
    importId: { type: Schema.Types.ObjectId, ref: "TeacherImport" },
    history: { type: [historySchema], default: [] },
    /** Plage déjà planifiée (« YYYY-MM-DD ») : évite de recalculer à chaque consultation. */
    plannedFrom: String,
    plannedThrough: String,
  },
  { timestamps: true }
);
timetableSchema.index({ teacherId: 1, classLevel: 1, schoolYear: 1 }, { unique: true });
export const Timetable = mongoose.model("Timetable", timetableSchema);

/** Séance prévue : progression de l'enseignant (distincte du programme officiel). */
const lessonInstanceSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    classLevel: { type: String, required: true },
    subjectCode: { type: String, required: true },
    nodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode", required: true },
    /** Date locale « YYYY-MM-DD » telle que vue par le téléphone de l'enseignant. */
    date: { type: String, required: true },
    start: String,
    end: String,
    slotId: Schema.Types.ObjectId,
    status: { type: String, enum: LESSON_STATUSES, default: "planned" },
    /** Pour un cours partiel : objectifs restant à traiter (indices dans node.objectives). */
    remainingObjectives: [Number],
    origin: { type: String, enum: ["plan", "catchup", "manual"], default: "plan" },
    catchUpOf: { type: Schema.Types.ObjectId, ref: "LessonInstance" },
    rev: { type: Number, default: 0 },
    /** Réglages propres à la fiche de CETTE séance (modifiée par l'enseignant avec l'IA) ; absent = préférences du profil. */
    docOptions: {
      _id: false,
      type: {
        difficulty: String,
        illustrationLevel: String,
        includeAnswers: Boolean,
        instruction: { type: String, maxlength: 400 },
        /** Illustration personnalisée de la fiche (image stockée, réglages choisis). */
        illustration: { url: String, aspect: Number, kind: String, level: String, color: Boolean, legends: Boolean, description: String },
      },
      default: undefined,
    },
    /** Brouillons d'illustration créés par l'IA, en attente de validation par l'enseignant (4 au plus). */
    illustrationDrafts: {
      type: [{ _id: false, id: String, url: String, aspect: Number, kind: String, level: String, color: Boolean, legends: Boolean, description: String, createdAt: String }],
      default: undefined,
    },
  },
  { timestamps: true }
);
lessonInstanceSchema.index({ teacherId: 1, date: 1, start: 1 });
lessonInstanceSchema.index({ teacherId: 1, classLevel: 1, subjectCode: 1, date: 1 });
export const LessonInstance = mongoose.model("LessonInstance", lessonInstanceSchema);

/**
 * Journal d'événements (bilan réel des séances). Ajout uniquement : jamais d'écrasement.
 * `opId` est généré par l'app : il rend la synchronisation hors connexion idempotente.
 */
const progressEventSchema = new Schema(
  {
    opId: { type: String, required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lessonId: { type: Schema.Types.ObjectId, ref: "LessonInstance", required: true },
    status: { type: String, enum: ["done", "partial", "missed"], required: true },
    objectivesDone: [Number],
    durationMin: Number,
    difficulties: { type: String, maxlength: 1000 },
    toRedo: { type: String, maxlength: 1000 },
    note: { type: String, maxlength: 2000 },
    /** Instant de saisie sur l'appareil (UTC). */
    recordedAt: { type: Date, required: true },
  },
  { timestamps: true }
);
progressEventSchema.index({ teacherId: 1, opId: 1 }, { unique: true });
progressEventSchema.index({ teacherId: 1, lessonId: 1, recordedAt: -1 });
export const ProgressEvent = mongoose.model("ProgressEvent", progressEventSchema);

/** Élément à rattraper : il ne disparaît jamais automatiquement tant qu'il n'est pas replanifié ou abandonné. */
const catchUpItemSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lessonId: { type: Schema.Types.ObjectId, ref: "LessonInstance", required: true, unique: true },
    nodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode", required: true },
    classLevel: String,
    subjectCode: String,
    reason: { type: String, enum: ["missed", "partial"], required: true },
    remainingObjectives: [Number],
    status: { type: String, enum: ["open", "scheduled", "resolved", "dropped"], default: "open" },
    scheduledLessonId: { type: Schema.Types.ObjectId, ref: "LessonInstance" },
  },
  { timestamps: true }
);
catchUpItemSchema.index({ teacherId: 1, status: 1 });
export const CatchUpItem = mongoose.model("CatchUpItem", catchUpItemSchema);
