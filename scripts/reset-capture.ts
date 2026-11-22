/**
 * Remet à l'état « à faire » les séances d'une journée du compte de capture (vidéos du site), pour que
 * le bilan puisse être filmé de nouveau : supprime les bilans enregistrés et les rattrapages ouverts
 * qu'ils ont créés. Refuse tout compte hors du domaine de test `@pedago.test`.
 *
 * Usage : CAPTURE_EMAIL=capture@pedago.test npx tsx scripts/reset-capture.ts [AAAA-MM-JJ]
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { uriDbName } from "../src/db/connect.js";
import { CatchUpItem, LessonInstance, ProgressEvent, User } from "../src/models/index.js";

const email = (process.env.CAPTURE_EMAIL ?? "").toLowerCase();
const date = process.argv[2] ?? "2026-11-24";
if (!/^[^@\s]+@pedago\.test$/.test(email)) {
  console.error("CAPTURE_EMAIL doit être un compte de test @pedago.test");
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Date attendue : AAAA-MM-JJ");
  process.exit(1);
}

await mongoose.connect(env.mongoUri, { dbName: uriDbName(env.mongoUri) ?? env.mongoDb });
try {
  const user = await User.findOne({ email, role: "teacher" }, { _id: 1 }).lean();
  if (!user) throw new Error(`Compte enseignant introuvable : ${email}`);
  const lessons = await LessonInstance.find({ teacherId: user._id, date }, { _id: 1 }).lean();
  const ids = lessons.map((l) => l._id);
  const [events, catchUps, reset] = await Promise.all([
    ProgressEvent.deleteMany({ teacherId: user._id, lessonId: { $in: ids } }),
    CatchUpItem.deleteMany({ teacherId: user._id, lessonId: { $in: ids }, status: "open" }),
    LessonInstance.updateMany({ _id: { $in: ids }, teacherId: user._id, status: { $in: ["done", "partial", "missed"] } }, { $set: { status: "planned", remainingObjectives: [] }, $inc: { rev: 1 } }),
  ]);
  console.log(`${date} : ${reset.modifiedCount} séance(s) remise(s) à faire, ${events.deletedCount} bilan(s) et ${catchUps.deletedCount} rattrapage(s) supprimés`);
} finally {
  await mongoose.disconnect();
}
