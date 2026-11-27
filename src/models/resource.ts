import mongoose, { Schema } from "mongoose";
import { DIFFICULTIES, ILLUSTRATION_LEVELS, RESOURCE_STATUSES, RESOURCE_TYPES } from "./domain.js";

const assetSchema = new Schema(
  { url: String, key: String, sizeBytes: Number, sha256: String, generatedAt: Date, contentVersion: Number },
  { _id: false }
);

/** Ressource pédagogique : contenu JSON structuré + exports PDF/DOCX générés une seule fois par version. */
const resourceSchema = new Schema(
  {
    type: { type: String, enum: RESOURCE_TYPES, required: true },
    subsystem: { type: String, enum: ["francophone", "anglophone"], required: true },
    classLevel: { type: String, required: true },
    subjectCode: { type: String, required: true },
    nodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode", required: true },
    title: { type: String, required: true, maxlength: 240 },
    summary: { type: String, maxlength: 600 },
    difficulty: { type: String, enum: DIFFICULTIES, default: "standard" },
    illustrationLevel: { type: String, enum: ILLUSTRATION_LEVELS, default: "simple" },
    durationMin: Number,
    content: { type: Schema.Types.Mixed, required: true },
    illustrations: [{ _id: false, url: String, key: String, caption: String, license: String }],
    sources: [{ _id: false, sourceId: { type: Schema.Types.ObjectId, ref: "SourceDocument" }, pages: [Number], note: String }],
    curriculumVersion: { type: String, required: true },
    contentVersion: { type: Number, default: 1 },
    contentBytes: { type: Number, default: 0 },
    schemaVersion: { type: Number, default: 1 },
    status: { type: String, enum: RESOURCE_STATUSES, default: "DRAFT" },
    origin: { type: String, enum: ["ai", "human", "seed"], default: "ai" },
    /** Empreinte de la demande de génération : évite de générer deux fois la même ressource. */
    generationKey: { type: String },
    aiJobId: { type: Schema.Types.ObjectId, ref: "AiJob" },
    /** Méthode de préparation officielle suivie à la génération (et sa mise en page, figée pour le PDF). */
    methodId: { type: Schema.Types.ObjectId, ref: "PreparationMethod" },
    methodVersion: Number,
    methodLayout: { type: Schema.Types.Mixed },
    aiReview: {
      score: Number,
      issues: [{ _id: false, severity: String, area: String, message: String }],
      model: String,
      checkedAt: Date,
    },
    /** Dernière personne ayant modifié le contenu (interdite de validation : principe des quatre yeux). */
    lastEditedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: Date,
    publishedAt: Date,
    assets: { pdf: assetSchema, docx: assetSchema },
  },
  { timestamps: true, minimize: false }
);
// Taille du contenu précalculée : les manifestes de téléchargement ne chargent pas le contenu.
resourceSchema.pre("save", function () {
  if (this.isModified("content")) this.set("contentBytes", Buffer.byteLength(JSON.stringify(this.get("content") ?? {})));
});
resourceSchema.index({ subsystem: 1, classLevel: 1, subjectCode: 1, status: 1 });
resourceSchema.index({ nodeId: 1, status: 1, type: 1 });
resourceSchema.index({ classLevel: 1, subjectCode: 1, nodeId: 1 });
resourceSchema.index({ type: 1, status: 1 });
resourceSchema.index({ generationKey: 1 }, { sparse: true });
resourceSchema.index({ title: "text", summary: "text" }, { default_language: "french" });
export const Resource = mongoose.model("Resource", resourceSchema);

/** Historique immuable : chaque version publiée est conservée. */
const resourceVersionSchema = new Schema(
  {
    resourceId: { type: Schema.Types.ObjectId, ref: "Resource", required: true, index: true },
    contentVersion: { type: Number, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User" },
    reason: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
resourceVersionSchema.index({ resourceId: 1, contentVersion: -1 }, { unique: true });
export const ResourceVersion = mongoose.model("ResourceVersion", resourceVersionSchema);

const editorialReviewSchema = new Schema(
  {
    resourceId: { type: Schema.Types.ObjectId, ref: "Resource", required: true, index: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    decision: { type: String, enum: ["approve", "reject", "request_changes", "comment", "regenerate"], required: true },
    comment: { type: String, maxlength: 4000 },
    fromStatus: String,
    toStatus: String,
    contentVersion: Number,
  },
  { timestamps: true }
);
export const EditorialReview = mongoose.model("EditorialReview", editorialReviewSchema);
