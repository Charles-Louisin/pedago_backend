import mongoose, { Schema } from "mongoose";

/**
 * Import « Mon programme » : un dossier de documents de l'enseignant (emploi du temps, curriculum, ou les deux),
 * lu en arrière-plan par la file `AiJob`, puis vérifié, corrigé et validé par l'enseignant.
 *
 * Répartition des rôles, sans doublon :
 * - les fichiers sont dans le stockage (UploadThing), référencés par `TeacherUpload` ; ici, seulement leurs métadonnées ;
 * - l'exécution (étapes, reprises, coût, tokens) est dans `AiJob` / `AiUsageLog` ;
 * - ce document garde le RÉSULTAT : classement, extraction brute validée (historique), brouillon corrigé
 *   par l'enseignant, et la version d'emploi du temps créée à la validation.
 */
export const IMPORT_STATUSES = ["queued", "processing", "ready", "failed", "validated", "cancelled"] as const;
export const IMPORT_CATEGORIES = ["timetable", "curriculum", "both", "other"] as const;

const fileSchema = new Schema(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "TeacherUpload", required: true },
    name: { type: String, maxlength: 200 },
    mime: { type: String, required: true },
    sizeBytes: Number,
    pages: Number,
    /** Ce que l'enseignant a annoncé (« Mon emploi du temps », « Mon curriculum ») ou « auto ». */
    declared: { type: String, enum: ["timetable", "curriculum", "auto"], default: "auto" },
    /** Classement par l'IA (ou par mots-clés sans IA), avec sa confiance. */
    category: { type: String, enum: IMPORT_CATEGORIES },
    confidence: Number,
    classifyNote: { type: String, maxlength: 300 },
  },
  { _id: false }
);

const teacherImportSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    classLevel: { type: String, required: true },
    schoolYear: { type: String, required: true },
    status: { type: String, enum: IMPORT_STATUSES, default: "queued" },
    files: { type: [fileSchema], default: [] },
    jobId: { type: Schema.Types.ObjectId, ref: "AiJob" },
    /** Avancement lisible par l'app (« Lecture de l'emploi du temps », 3 sur 5). */
    progress: { step: String, label: String, done: { type: Number, default: 0 }, total: { type: Number, default: 0 } },
    /** Lecture : « ai » (modèle) ou « text » (lecture directe du texte, sans IA). */
    readBy: { type: String, enum: ["ai", "text"] },
    /** Extraction validée par schéma, telle que lue : jamais modifiée ensuite (historique des extractions). */
    extraction: { type: Schema.Types.Mixed, default: null },
    /** Brouillon : extraction + rapprochement + reconstruction, puis corrections de l'enseignant. */
    draft: { type: Schema.Types.Mixed, default: null },
    error: { code: String, message: String },
    validatedAt: Date,
    /** Version d'emploi du temps créée à la validation. */
    timetableVersion: Number,
  },
  { timestamps: true, minimize: false }
);
teacherImportSchema.index({ teacherId: 1, createdAt: -1 });
export const TeacherImport = mongoose.model("TeacherImport", teacherImportSchema);
