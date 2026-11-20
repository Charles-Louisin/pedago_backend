import "dotenv/config";
import path from "node:path";
import { MongoClient } from "mongodb";
import { backupKey, restoreDatabase } from "./backup-lib.js";

/**
 * Restauration : npm run restore -- <dossier de sauvegarde> --uri <base cible> [--drop]
 * Vérifie les empreintes, refuse d'écraser une base non vide sans --drop, recrée les index,
 * puis compare le nombre de documents restaurés à celui du manifeste.
 */
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const uriIdx = args.indexOf("--uri");
const uri = uriIdx >= 0 ? args[uriIdx + 1] : undefined;
if (!dir || !uri) {
  console.error("Usage : npm run restore -- <dossier> --uri mongodb://hôte/base [--drop]");
  process.exit(1);
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const { manifest, report } = await restoreDatabase(client.db(), path.resolve(dir), backupKey(), { drop: args.includes("--drop") });
  const bad = report.filter((r) => r.restored !== r.expected);
  for (const r of report) console.log(`${r.restored === r.expected ? "✓" : "✗"} ${r.name} : ${r.restored}/${r.expected}`);
  console.log(`Restauration de la sauvegarde du ${manifest.createdAt} dans « ${client.db().databaseName} » : ${bad.length ? "INCOMPLÈTE" : "complète"}`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("Échec de la restauration :", (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.close();
}
