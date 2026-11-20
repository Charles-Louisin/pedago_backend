import mongoose, { Schema } from "mongoose";

/** Matière, propre à un sous-système (pas de simple traduction entre sous-systèmes). */
const subjectSchema = new Schema(
  {
    code: { type: String, required: true },
    subsystem: { type: String, enum: ["francophone", "anglophone"], required: true },
    name: { type: String, required: true },
    color: { type: String, default: "#0B7A4B" },
    icon: { type: String, default: "book" },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);
subjectSchema.index({ subsystem: 1, code: 1 }, { unique: true });
export const Subject = mongoose.model("Subject", subjectSchema);

/**
 * Nœud du référentiel : domaine → unité/séquence → compétence → leçon.
 * C'est le programme officiel structuré ; la progression de l'enseignant s'appuie dessus sans le modifier.
 */
const curriculumNodeSchema = new Schema(
  {
    subsystem: { type: String, enum: ["francophone", "anglophone"], required: true },
    classLevel: { type: String, required: true },
    subjectCode: { type: String, required: true },
    kind: { type: String, enum: ["domain", "unit", "competency", "lesson"], required: true },
    parentId: { type: Schema.Types.ObjectId, ref: "CurriculumNode" },
    title: { type: String, required: true, maxlength: 240 },
    description: String,
    objectives: [String],
    durationMin: { type: Number, default: 45 },
    /** Ordre dans la progression type de l'année. */
    order: { type: Number, default: 0 },
    term: { type: Number, min: 1, max: 3 },
    /** Leçons qui doivent avoir été traitées avant celle-ci (utilisé par le moteur de rattrapage). */
    prerequisites: [{ type: Schema.Types.ObjectId, ref: "CurriculumNode" }],
    priority: { type: Number, default: 2, min: 1, max: 3 },
    sourceRefs: [{ _id: false, sourceId: { type: Schema.Types.ObjectId, ref: "SourceDocument" }, pages: [Number] }],
    curriculumVersion: { type: String, required: true },
    status: { type: String, enum: ["extracted", "validated", "retired"], default: "extracted" },
    /** Progression personnelle d'un enseignant (absent = programme officiel). */
    ownerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** Leçon officielle correspondante (pour retrouver les ressources de la bibliothèque). */
    matchedNodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode" },
    /** Leçon déjà enseignée avant l'import de la progression (non replanifiée, comptée comme faite). */
    alreadyTaught: { type: Boolean, default: false },
  },
  { timestamps: true }
);
curriculumNodeSchema.index({ subsystem: 1, classLevel: 1, subjectCode: 1, order: 1 });
curriculumNodeSchema.index({ parentId: 1 });
curriculumNodeSchema.index({ ownerId: 1, classLevel: 1, subjectCode: 1, order: 1 });
export const CurriculumNode = mongoose.model("CurriculumNode", curriculumNodeSchema);

/** Calendrier scolaire versionné : trimestres, congés, examens. */
const academicCalendarSchema = new Schema(
  {
    schoolYear: { type: String, required: true, unique: true },
    startsOn: { type: String, required: true },
    endsOn: { type: String, required: true },
    terms: [{ _id: false, number: Number, startsOn: String, endsOn: String }],
    breaks: [{ _id: false, label: String, startsOn: String, endsOn: String, kind: { type: String, enum: ["holiday", "vacation", "exam"] } }],
    /** Le calendrier doit être vérifié contre l'arrêté officiel avant d'être marqué « verified ». */
    verified: { type: Boolean, default: false },
    sourceId: { type: Schema.Types.ObjectId, ref: "SourceDocument" },
  },
  { timestamps: true }
);
export const AcademicCalendar = mongoose.model("AcademicCalendar", academicCalendarSchema);

/** Source documentaire traçable : chaque contenu publié pointe vers une ou plusieurs sources. */
const sourceDocumentSchema = new Schema(
  {
    title: { type: String, required: true },
    issuer: { type: String, required: true },
    url: String,
    fileUrl: String,
    fileKey: String,
    publishedOn: String,
    consultedAt: { type: Date, default: Date.now },
    reference: String,
    docType: { type: String, enum: ["curriculum", "law", "calendar", "textbook_list", "exam", "guide", "other"], default: "other" },
    sha256: String,
    usageRights: { type: String, enum: ["public_official", "licensed", "reference_only", "unknown"], default: "unknown" },
    nextReviewOn: String,
    extractedText: { type: String, select: false },
    pageCount: Number,
    status: { type: String, enum: ["pending", "fetched", "extracted", "verified", "rejected"], default: "pending" },
    notes: String,
  },
  { timestamps: true }
);
sourceDocumentSchema.index({ sha256: 1 }, { sparse: true });
export const SourceDocument = mongoose.model("SourceDocument", sourceDocumentSchema);
