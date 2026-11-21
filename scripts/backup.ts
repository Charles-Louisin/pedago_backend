import "dotenv/config";
import path from "node:path";
import { MongoClient } from "mongodb";
import { backupDatabase, backupKey, pruneBackups, stamp } from "./backup-lib.js";

/**
 * Sauvegarde : npm run backup
 * MONGODB_URI (base à sauvegarder), BACKUP_DIR (défaut ./backups), BACKUP_RETENTION_DAYS (défaut 30),
 * BACKUP_KEY (32 octets, hex ou base64) : chiffrement obligatoire en production.
 * À planifier chaque nuit (cron, tâche planifiée) et à copier hors du serveur.
 */
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/pedago";
const root = path.resolve(process.env.BACKUP_DIR || "backups");
const days = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const key = backupKey();
if (!key && process.env.NODE_ENV === "production") {
  console.error("BACKUP_KEY manquant : en production, les sauvegardes (données personnelles) doivent être chiffrées.");
  process.exit(1);
}

const client = new MongoClient(uri);
// Base nommée dans l'adresse, sinon MONGODB_DB (« pedago ») : comme l'API, jamais la base « test » par défaut.
const dbNameOf = (u: string) => u.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/)?.[1] ?? process.env.MONGODB_DB ?? "pedago";
const started = Date.now();
try {
  await client.connect();
  const dir = path.join(root, stamp());
  const m = await backupDatabase(client.db(dbNameOf(uri)), dir, key);
  const total = m.collections.reduce((s, c) => s + c.count, 0);
  console.log(`Sauvegarde ${m.encrypted ? "chiffrée " : ""}de « ${m.database} » : ${m.collections.length} collections, ${total} documents → ${dir} (${Date.now() - started} ms)`);
  const removed = pruneBackups(root, days);
  if (removed.length) console.log(`Anciennes sauvegardes supprimées (> ${days} jours) : ${removed.join(", ")}`);
} catch (e) {
  console.error("Échec de la sauvegarde :", (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.close();
}
