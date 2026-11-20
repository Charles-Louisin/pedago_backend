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
