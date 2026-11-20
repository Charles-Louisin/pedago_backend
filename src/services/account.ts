import { Types } from "mongoose";
import {
  AuditLog,
  CatchUpItem,
  CurriculumNode,
  GeneratedDocument,
  LessonInstance,
  ProgressEvent,
  Session,
  TeacherPrep,
  TeacherProfile,
  Timetable,
  User,
} from "../models/index.js";
import { deleteStoredFile } from "./storage.js";

/**
 * Droits de l'enseignant sur ses données (loi camerounaise n° 2024/017) :
 * accès / portabilité (export complet en JSON) et effacement (suppression définitive du compte).
 */
export async function exportAccount(userId: string) {
  const id = new Types.ObjectId(userId);
  const [user, profile, timetables, lessons, events, catchups, preps, curriculum, documents, sessions] = await Promise.all([
    User.findById(id).select("fullName email phone role emailVerified createdAt lastLoginAt").lean(),
    TeacherProfile.findOne({ userId: id }).lean(),
    Timetable.find({ teacherId: id }).lean(),
    LessonInstance.find({ teacherId: id }).select("-__v").lean(),
    ProgressEvent.find({ teacherId: id }).select("-__v").lean(),
    CatchUpItem.find({ teacherId: id }).select("-__v").lean(),
    TeacherPrep.find({ teacherId: id }).select("-__v").lean(),
    CurriculumNode.find({ ownerId: id }).select("-__v").lean(),
    GeneratedDocument.find({ teacherId: id }).select("url sizeBytes createdAt").lean(),
    Session.find({ userId: id }).select("device createdAt lastUsedAt revokedAt").lean(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    format: "pedago-export-v1",
    account: user,
    profile,
    timetables,
    curriculum,
    preps,
    lessons,
    reports: events,
    catchUp: catchups,
    documents,
    sessions,
  };
}

/** Efface toutes les données de l'enseignant et ses fichiers personnels. Irréversible. */
export async function deleteAccount(userId: string, ip?: string) {
  const id = new Types.ObjectId(userId);
  const docs = await GeneratedDocument.find({ teacherId: id }).select("url key").lean();
  const prepFiles = await TeacherPrep.find({ teacherId: id, fileUrl: { $ne: null } }).select("fileUrl").lean();
  await Promise.all([
    ...docs.map((d) => deleteStoredFile(d.key, d.url)),
    ...prepFiles.map((p) => deleteStoredFile(p.fileUrl!.split("/").pop()!, p.fileUrl!)),
  ]);
  await Promise.all([
    GeneratedDocument.deleteMany({ teacherId: id }),
    TeacherPrep.deleteMany({ teacherId: id }),
    CatchUpItem.deleteMany({ teacherId: id }),
    ProgressEvent.deleteMany({ teacherId: id }),
    LessonInstance.deleteMany({ teacherId: id }),
    Timetable.deleteMany({ teacherId: id }),
    CurriculumNode.deleteMany({ ownerId: id }),
    TeacherProfile.deleteOne({ userId: id }),
    Session.deleteMany({ userId: id }),
    // Journaux de sécurité conservés, mais détachés de la personne.
    AuditLog.updateMany({ actorId: id }, { $unset: { actorId: 1, ip: 1 } }),
  ]);
  await User.deleteOne({ _id: id });
  // Trace minimale, sans donnée personnelle : seulement l'identifiant technique supprimé.
  await AuditLog.create({ action: "account.deleted", target: userId, ip });
}
