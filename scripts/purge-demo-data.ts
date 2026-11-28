/**
 * Supprime les données FICTIVES de la base configurée (MONGODB_URI) : tout ce qui ne vient ni d'un document
 * déposé dans Sources ni d'une vraie personne.
 *  - leçons, unités et domaines de démonstration ou de test (versions « demo-2026 », « 2026-test ») ;
 *  - ressources de démonstration (origine « seed », « CONTENU DE DÉMONSTRATION ») et celles générées sur ces leçons ;
 *  - sources de test (titre contenant « (test) ») ;
 *  - calendrier scolaire d'exemple non vérifié ;
 *  - comptes de test (@pedago.test) avec toutes leurs données (profil, emploi du temps, séances, imports…) ;
 *  - matières qu'aucune leçon restante n'utilise (elles reviennent depuis les programmes analysés).
 * Vos documents déposés, leurs analyses et les vrais comptes sont gardés.
 *
 * Par défaut : simple inventaire, rien n'est supprimé. Avec --apply : une copie de chaque document supprimé
 * est d'abord écrite dans backups/purge-<date>.json (fichier local, ignoré par git), puis la suppression a lieu.
 * Usage : npx tsx scripts/purge-demo-data.ts [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { EJSON } from "bson";
import { env } from "../src/config/env.js";
import { uriDbName } from "../src/db/connect.js";
import { AcademicCalendar, CurriculumNode, Resource, SourceDocument, Subject, User } from "../src/models/index.js";
import { deleteAccount } from "../src/services/account.js";

const apply = process.argv.includes("--apply");
await mongoose.connect(env.mongoUri, { dbName: uriDbName(env.mongoUri) ?? env.mongoDb, serverSelectionTimeoutMS: 10_000 });
const host = env.mongoUri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?]/)[0];
console.log(`Base : ${host} / ${mongoose.connection.db!.databaseName} — ${apply ? "SUPPRESSION" : "inventaire seul (ajoute --apply pour supprimer)"}`);

try {
  const testSources = await SourceDocument.find({ title: /\(test\)/i }).lean();
  const fakeNodes = await CurriculumNode.find({
    ownerId: null,
    $or: [{ curriculumVersion: { $in: ["demo-2026", "2026-test"] } }, { "sourceRefs.sourceId": { $in: testSources.map((s) => s._id) } }],
  }).lean();
  const fakeNodeIds = fakeNodes.map((n) => n._id);
  const fakeResources = await Resource.find({
    $or: [{ origin: "seed" }, { "content.body": /^CONTENU DE DÉMONSTRATION/ }, { nodeId: { $in: fakeNodeIds } }, { curriculumVersion: { $in: ["demo-2026", "2026-test"] } }],
  }).lean();
  const fakeCalendars = await AcademicCalendar.find({ verified: { $ne: true } }).lean();
  const testUsers = await User.find({ email: /@pedago\.test$/i }).select("email role").lean();

  // Matières encore utilisées par une leçon réelle (ou par un document analysé) : gardées.
  const used = new Set<string>(
    (await CurriculumNode.find({ ownerId: null, _id: { $nin: fakeNodeIds } }).select("subsystem subjectCode").lean()).map((n) => `${n.subsystem}|${n.subjectCode}`)
  );
  for (const s of await SourceDocument.find({ "extraction.subjects.0": { $exists: true } }).select("extraction").lean())
    for (const sub of s.extraction?.subjects ?? []) used.add(`${s.extraction?.subsystem}|${sub.code}`);
  const unusedSubjects = (await Subject.find().lean()).filter((s) => !used.has(`${s.subsystem}|${s.code}`));

  const rows: [string, number, string][] = [
    ["Leçons, unités et domaines fictifs", fakeNodes.length, [...new Set(fakeNodes.map((n) => n.curriculumVersion))].join(", ")],
    ["Ressources fictives", fakeResources.length, `${fakeResources.filter((r) => r.origin === "seed").length} de démonstration, ${fakeResources.filter((r) => r.origin !== "seed").length} générées sur des leçons fictives`],
    ["Sources de test", testSources.length, testSources.map((s) => s.title).join(" · ")],
    ["Calendrier d'exemple", fakeCalendars.length, fakeCalendars.map((c) => c.schoolYear).join(", ")],
    ["Comptes de test (et leurs données)", testUsers.length, testUsers.map((u) => `${u.email} (${u.role})`).join(", ")],
    ["Matières non utilisées", unusedSubjects.length, unusedSubjects.map((s) => `${s.code}`).join(", ")],
  ];
  for (const [label, n, detail] of rows) console.log(`- ${label} : ${n}${detail ? `  [${detail.slice(0, 300)}]` : ""}`);
  const kept = await SourceDocument.countDocuments({ _id: { $nin: testSources.map((s) => s._id) } });
  const realUsers = await User.countDocuments({ email: { $not: /@pedago\.test$/i } });
  console.log(`Gardés : ${kept} document(s) déposé(s), ${realUsers} compte(s) réel(s).`);

  if (apply) {
    fs.mkdirSync("backups", { recursive: true });
    const file = path.join("backups", `purge-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, EJSON.stringify({ fakeNodes, fakeResources, testSources, fakeCalendars, testUsers, unusedSubjects }, { relaxed: false }));
    console.log(`Copie de sauvegarde : ${file}`);
    await CurriculumNode.deleteMany({ _id: { $in: fakeNodeIds } });
    await Resource.deleteMany({ _id: { $in: fakeResources.map((r) => r._id) } });
    await SourceDocument.deleteMany({ _id: { $in: testSources.map((s) => s._id) } });
    await AcademicCalendar.deleteMany({ _id: { $in: fakeCalendars.map((c) => c._id) } });
    for (const u of testUsers) await deleteAccount(String(u._id));
    await Subject.deleteMany({ _id: { $in: unusedSubjects.map((s) => s._id) } });
    console.log("Données fictives supprimées.");
  }
} finally {
  await mongoose.disconnect();
}
