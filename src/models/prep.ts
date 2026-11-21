import mongoose, { Schema } from "mongoose";

/** Fiche de préparation de l'enseignant pour une leçon : elle prime sur la bibliothèque lors de l'export. */
const teacherPrepSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    nodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode", required: true },
    content: { type: Schema.Types.Mixed, default: {} },
    /** Mise en page relevée sur la fiche d'origine (titre, en-tête, rubriques, colonnes). */
    layout: { type: Schema.Types.Mixed, default: null },
    fileUrl: String,
    fileName: String,
    fileMime: String,
  },
  { timestamps: true, minimize: false }
);
teacherPrepSchema.index({ teacherId: 1, nodeId: 1 }, { unique: true });
export const TeacherPrep = mongoose.model("TeacherPrep", teacherPrepSchema);

/**
 * Documents personnels générés (fiche de l'enseignant + bibliothèque) : rattachés à leur auteur
 * pour pouvoir les effacer avec son compte. Référence seulement, le fichier est dans le stockage.
 */
const generatedDocumentSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    lessonId: { type: Schema.Types.ObjectId, ref: "LessonInstance" },
    url: { type: String, required: true },
    key: { type: String, required: true },
    sizeBytes: Number,
  },
  { timestamps: true }
);
export const GeneratedDocument = mongoose.model("GeneratedDocument", generatedDocumentSchema);

/**
 * Fichier déposé par l'enseignant (sa fiche en PDF ou en photo) : rattaché à son auteur,
 * effacé avec son compte. Une fiche ne peut citer qu'un fichier de son propre auteur.
 */
const teacherUploadSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // « figure » : image recadrée sur une fiche importée (logo, armoiries, dessin), réutilisée par l'aperçu et le PDF.
    kind: { type: String, enum: ["prep", "curriculum", "figure"], required: true },
    url: { type: String, required: true },
    key: { type: String, required: true },
    name: { type: String, maxlength: 200 },
    mime: String,
    sizeBytes: Number,
    sha256: String,
  },
  { timestamps: true }
);
export const TeacherUpload = mongoose.model("TeacherUpload", teacherUploadSchema);

/**
 * Contenu d'une fiche adapté à un niveau de difficulté par l'IA : conservé pour que l'aperçu et le PDF
 * téléchargé soient identiques sans payer deux fois. Clé : leçon + niveau + empreinte du contenu source.
 */
const adaptedContentSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    nodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode", required: true },
    difficulty: { type: String, required: true },
    sourceHash: { type: String, required: true },
    content: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
  },
  { minimize: false }
);
adaptedContentSchema.index({ teacherId: 1, nodeId: 1, difficulty: 1, sourceHash: 1 }, { unique: true });
export const AdaptedContent = mongoose.model("AdaptedContent", adaptedContentSchema);
