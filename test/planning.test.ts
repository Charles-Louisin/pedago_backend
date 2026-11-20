import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AcademicCalendar, CatchUpItem, CurriculumNode, LessonInstance, Timetable, User } from "../src/models/index.js";
import { applyCatchUp, ensurePlan, isSchoolDay, proposeCatchUp } from "../src/services/planning.js";
import { addDays, weekday } from "../src/utils/dates.js";

let mongo: MongoMemoryServer;
let teacherId: string;

before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-test"));
  const user = await User.create({ fullName: "Test", email: "t@test.cm", passwordHash: "x" });
  teacherId = String(user._id);
  await AcademicCalendar.create({
    schoolYear: "2026-2027",
    startsOn: "2026-09-07",
    endsOn: "2027-06-04",
    terms: [],
    breaks: [{ label: "Congé test", startsOn: "2026-11-25", endsOn: "2026-11-25", kind: "holiday" }],
  });
  for (let i = 1; i <= 8; i++) {
    await CurriculumNode.create({
      subsystem: "francophone", classLevel: "CP", subjectCode: "MATH", kind: "lesson",
      title: `Leçon ${i}`, objectives: ["a", "b"], order: i, priority: i === 4 ? 3 : 2,
      curriculumVersion: "t", status: "validated",
    });
  }
  // Maths le lundi et le mercredi à 8 h.
  await Timetable.create({
    teacherId, classLevel: "CP", schoolYear: "2026-2027",
    slots: [{ weekday: 1, start: "08:00", end: "09:00", subjectCode: "MATH" }, { weekday: 3, start: "08:00", end: "09:00", subjectCode: "MATH" }],
  });
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test("dates locales", () => {
  assert.equal(weekday("2026-11-23"), 1);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("jours de classe : congés et hors année exclus", () => {
  const cal = { startsOn: "2026-09-07", endsOn: "2027-06-04", breaks: [{ startsOn: "2026-11-25", endsOn: "2026-11-25" }] };
  assert.equal(isSchoolDay(cal, "2026-11-25"), false);
  assert.equal(isSchoolDay(cal, "2026-11-23"), true);
  assert.equal(isSchoolDay(cal, "2026-07-01"), false);
});

test("planification déterministe et idempotente, congés sautés", async () => {
  const created = await ensurePlan(teacherId, "CP", "2026-2027", "2026-11-23", "2026-12-06");
  // lun 23, (mer 25 = congé), lun 30, mer 2, (lun 7 hors plage) → 3 séances
  assert.equal(created, 3);
  assert.equal(await ensurePlan(teacherId, "CP", "2026-2027", "2026-11-23", "2026-12-06"), 0);
  const lessons = await LessonInstance.find({ teacherId }).sort({ date: 1 }).populate<{ nodeId: { title: string } }>("nodeId", "title").lean();
  assert.deepEqual(lessons.map((l) => [l.date, l.nodeId.title]), [
    ["2026-11-23", "Leçon 1"],
    ["2026-11-30", "Leçon 2"],
    ["2026-12-02", "Leçon 3"],
  ]);
});

test("rattrapage : insertion au prochain créneau, la suite glisse, rien ne se perd", async () => {
  const first = await LessonInstance.findOne({ teacherId, date: "2026-11-23" });
  first!.status = "missed";
  await first!.save();
  const item = await CatchUpItem.create({ teacherId, lessonId: first!._id, nodeId: first!.nodeId, classLevel: "CP", subjectCode: "MATH", reason: "missed" });

  const proposal = await proposeCatchUp(teacherId, String(item._id), "2026-11-23");
  const insert = proposal!.options.find((o) => o.kind === "insert_next_slot") as { lessonId: string };
  assert.ok(insert);
  await applyCatchUp(teacherId, String(item._id), "insert_next_slot", insert.lessonId);

  const after = await LessonInstance.find({ teacherId, date: { $gt: "2026-11-23" } }).sort({ date: 1 }).populate<{ nodeId: { title: string } }>("nodeId", "title").lean();
  assert.deepEqual(after.map((l) => l.nodeId.title), ["Leçon 1", "Leçon 2"]);
  assert.equal(after[0].origin, "catchup");
  // La leçon 3 décalée est replanifiée au créneau libre suivant.
  await ensurePlan(teacherId, "CP", "2026-2027", "2026-11-23", "2026-12-09");
  const titles = (await LessonInstance.find({ teacherId, status: "planned" }).sort({ date: 1 }).populate<{ nodeId: { title: string } }>("nodeId", "title").lean()).map((l) => l.nodeId.title);
  assert.ok(titles.includes("Leçon 3"));
  assert.equal((await CatchUpItem.findById(item._id))!.status, "scheduled");
});

test("une autre personne ne peut pas appliquer le rattrapage", async () => {
  const other = new mongoose.Types.ObjectId().toString();
  const item = await CatchUpItem.findOne({ teacherId });
  assert.equal(await proposeCatchUp(other, String(item!._id), "2026-11-23"), null);
});
