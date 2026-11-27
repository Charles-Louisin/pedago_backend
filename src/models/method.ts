import mongoose, { Schema } from "mongoose";

/**
 * Méthode de préparation officielle, relevée dans un guide pédagogique ou une fiche modèle (Sources) :
 * cartouche, rubriques dans l'ordre et avec les intitulés du document, étapes de la démarche, règles de
 * rédaction. L'analyse est faite UNE fois, rangée ici, relue et validée par un humain ; la génération des
 * leçons n'utilise que des méthodes validées (jamais le texte brut du guide).
 *
 * Portée : `classLevels` / `subjectCodes` vides = toutes les classes / toutes les matières du sous-système.
 * Quand plusieurs méthodes validées s'appliquent, la plus précise l'emporte (matière, puis classe).
 */
export const METHOD_STATUSES = ["extracted", "validated", "retired"] as const;
export type MethodStatus = (typeof METHOD_STATUSES)[number];

const methodSchema = new Schema(
  {
    sourceId: { type: Schema.Types.ObjectId, ref: "SourceDocument", required: true },
    /** Intitulé lu dans le document (« Démarche de la leçon de lecture »…). */
    title: { type: String, required: true, maxlength: 200 },
    subsystem: { type: String, enum: ["francophone", "anglophone"], required: true },
    classLevels: { type: [String], default: [] },
    subjectCodes: { type: [String], default: [] },
    /** Types de ressources concernés (par défaut : la fiche de préparation). */
    resourceTypes: { type: [String], default: ["lesson_plan"] },
    /** Mise en page (même format que le modèle de fiche d'un enseignant) : cartouche, rubriques, colonnes. */
    layout: { type: Schema.Types.Mixed, required: true },
    /** Consigne de chaque rubrique, telle que le guide la formule (indexée par intitulé). */
    sectionGuidance: { type: [{ _id: false, label: String, guidance: String }], default: [] },
    /** Étapes de la démarche, dans l'ordre, avec leurs intitulés exacts. */
    steps: {
      type: [{ _id: false, name: String, purpose: String, durationMin: Number, teacherRole: String, learnerRole: String }],
      default: [],
    },
    /** Rubriques propres à la méthode, hors rubriques standard (« Méthodes et techniques »…). */
    extraSections: { type: [{ _id: false, label: String, guidance: String }], default: [] },
    /** Règles de rédaction explicites du document (formulation des objectifs, temps, vocabulaire…). */
    conventions: { type: [String], default: [] },
    /** Pages du document d'où vient la méthode. */
    pages: { type: [Number], default: [] },
    /** Ce que l'analyse n'a pas pu établir ou a trouvé incohérent : à lire avant de valider. */
    warnings: { type: [String], default: [] },
    status: { type: String, enum: METHOD_STATUSES, default: "extracted" },
    promptVersion: String,
    jobId: { type: Schema.Types.ObjectId, ref: "AiJob" },
    sourceSha256: String,
    validatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    validatedAt: Date,
    /** Version, augmentée à chaque modification : les ressources gardent la version suivie. */
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);
methodSchema.index({ subsystem: 1, status: 1 });
methodSchema.index({ sourceId: 1 });
export const PreparationMethod = mongoose.model("PreparationMethod", methodSchema);
