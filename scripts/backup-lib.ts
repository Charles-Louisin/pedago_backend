import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import zlib from "node:zlib";
import { BSON, type Db } from "mongodb";

/**
 * Sauvegarde logique de la base : une collection = un fichier EJSON (types MongoDB conservés),
 * compressé (gzip) et chiffré (AES-256-GCM) quand BACKUP_KEY est défini. Un manifeste
 * garde les nombres de documents, empreintes SHA-256 et index pour vérifier la restauration.
 */
export type Manifest = {
  format: "pedago-backup-v1";
  createdAt: string;
  database: string;
  encrypted: boolean;
  collections: { name: string; file: string; count: number; sha256: string; authTag?: string; indexes: unknown[] }[];
};

const IV_BYTES = 12;

export function backupKey() {
  const raw = process.env.BACKUP_KEY?.trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("BACKUP_KEY doit faire 32 octets (64 caractères hexadécimaux ou base64).");
  return key;
}

function sha256File(file: string) {
  return new Promise<string>((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

export async function backupDatabase(db: Db, dir: string, key: Buffer | null): Promise<Manifest> {
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Manifest = { format: "pedago-backup-v1", createdAt: new Date().toISOString(), database: db.databaseName, encrypted: Boolean(key), collections: [] };
  const names = (await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
  for (const name of names) {
    const coll = db.collection(name);
    const file = `${name}.ejson.gz${key ? ".enc" : ""}`;
    const target = path.join(dir, file);
    let count = 0;
    const lines = Readable.from(
      (async function* () {
        for await (const doc of coll.find({}, { batchSize: 1000 })) {
          count += 1;
          yield BSON.EJSON.stringify(doc, { relaxed: false }) + "\n";
        }
      })()
    );
    const out = fs.createWriteStream(target);
    let authTag: string | undefined;
    if (key) {
      const iv = crypto.randomBytes(IV_BYTES);
      out.write(iv);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      await pipeline(lines, zlib.createGzip({ level: 6 }), cipher, out);
      authTag = cipher.getAuthTag().toString("hex");
    } else {
      await pipeline(lines, zlib.createGzip({ level: 6 }), out);
    }
    manifest.collections.push({ name, file, count, sha256: await sha256File(target), authTag, indexes: await coll.indexes() });
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Flux déchiffré et décompressé d'un fichier de sauvegarde ; les erreurs remontent au lecteur. */
function openBackupFile(file: string, key: Buffer | null, authTag?: string) {
  const out = new PassThrough();
  const gunzip = zlib.createGunzip();
  let chain: Promise<void>;
  if (key) {
    const iv = Buffer.alloc(IV_BYTES);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, iv, 0, IV_BYTES, 0);
    fs.closeSync(fd);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(authTag ?? "", "hex"));
    chain = pipeline(fs.createReadStream(file, { start: IV_BYTES }), decipher, gunzip, out);
  } else {
    chain = pipeline(fs.createReadStream(file), gunzip, out);
  }
  chain.catch((e: Error) => out.destroy(e));
  return out;
}

/** Vérifie les empreintes, puis réinsère chaque collection (par lots) et recrée ses index. */
export async function restoreDatabase(db: Db, dir: string, key: Buffer | null, opts: { drop: boolean }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== "pedago-backup-v1") throw new Error("Format de sauvegarde inconnu");
  if (manifest.encrypted && !key) throw new Error("Sauvegarde chiffrée : BACKUP_KEY requis");
  for (const c of manifest.collections) {
    const actual = await sha256File(path.join(dir, c.file));
    if (actual !== c.sha256) throw new Error(`Fichier altéré : ${c.file}`);
  }
  // Déchiffrement complet de chaque fichier AVANT toute écriture : mauvaise clé ou fichier corrompu = rien n'est touché.
  for (const c of manifest.collections) {
    try {
      await pipeline(openBackupFile(path.join(dir, c.file), manifest.encrypted ? key : null, c.authTag), new Writable({ write: (_chunk, _enc, cb) => cb() }));
    } catch {
      throw new Error(`Impossible de lire ${c.file} : clé de sauvegarde incorrecte ou fichier corrompu`);
    }
  }
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const c of manifest.collections) {
    if (existing.has(c.name) && (await db.collection(c.name).estimatedDocumentCount()) > 0 && !opts.drop) {
      throw new Error(`La collection ${c.name} n'est pas vide : relance avec --drop pour la remplacer`);
    }
  }

  const report: { name: string; expected: number; restored: number }[] = [];
  for (const c of manifest.collections) {
    const coll = db.collection(c.name);
    if (opts.drop && existing.has(c.name)) await coll.drop();
    const source = openBackupFile(path.join(dir, c.file), manifest.encrypted ? key : null, c.authTag);
    let batch: Record<string, unknown>[] = [];
    let restored = 0;
    const flush = async () => {
      if (!batch.length) return;
      await coll.insertMany(batch, { ordered: false });
      restored += batch.length;
      batch = [];
    };
    for await (const line of readline.createInterface({ input: source, crlfDelay: Infinity })) {
      if (!line) continue;
      batch.push(BSON.EJSON.parse(line, { relaxed: false }) as Record<string, unknown>);
      if (batch.length >= 1000) await flush();
    }
    await flush();
    for (const ix of c.indexes as { name: string; key: Record<string, 1 | -1>; [k: string]: unknown }[]) {
      if (ix.name === "_id_") continue;
      const { key: ixKey, v: _v, ns: _ns, ...rest } = ix;
      await coll.createIndex(ixKey, rest);
    }
    report.push({ name: c.name, expected: c.count, restored });
  }
  return { manifest, report };
}

/** Garde les sauvegardes des N derniers jours (dossiers horodatés). */
export function pruneBackups(root: string, days: number) {
  if (!fs.existsSync(root)) return [];
  const limit = Date.now() - days * 86_400_000;
  const removed: string[] = [];
  for (const name of fs.readdirSync(root)) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(name);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    if (at < limit) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

export const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
