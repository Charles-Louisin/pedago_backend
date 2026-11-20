import mongoose, { Schema } from "mongoose";

/** Fiche de préparation de l'enseignant pour une leçon : elle prime sur la bibliothèque lors de l'export. */
const teacherPrepSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    nodeId: { type: Schema.Types.ObjectId, ref: "CurriculumNode", required: true },
    content: { type: Schema.Types.Mixed, default: {} },
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
    kind: { type: String, enum: ["prep", "curriculum"], required: true },
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
