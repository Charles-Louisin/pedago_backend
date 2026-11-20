import mongoose, { Schema } from "mongoose";
import { LESSON_STATUSES } from "./domain.js";

/** Emploi du temps hebdomadaire : heures locales « HH:mm », jour 1 (lundi) à 6 (samedi). */
const timetableSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    classLevel: { type: String, required: true },
    schoolYear: { type: String, required: true },
    slots: [
      {
        weekday: { type: Number, min: 1, max: 7, required: true },
        start: { type: String, match: /^\d{2}:\d{2}$/, required: true },
        end: { type: String, match: /^\d{2}:\d{2}$/, required: true },
        subjectCode: { type: String, required: true },
      },
    ],
    version: { type: Number, default: 1 },
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
    status: { type: String, enum: ["open", "scheduled", "dropped"], default: "open" },
    scheduledLessonId: { type: Schema.Types.ObjectId, ref: "LessonInstance" },
  },
  { timestamps: true }
);
catchUpItemSchema.index({ teacherId: 1, status: 1 });
export const CatchUpItem = mongoose.model("CatchUpItem", catchUpItemSchema);
