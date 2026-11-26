/**
 * Envoie un média du site public sur UploadThing et enregistre ses adresses en base (collection SiteMedia).
 * Remplace l'entrée existante et efface ensuite les anciens fichiers d'UploadThing.
 *
 * Usage (depuis pedago-api) :
 *   npx tsx scripts/upload-site-media.ts <clé> <dossier>
 * Le dossier contient : pub.webm, pub.mp4 (1080p), pub-720.webm, pub-720.mp4 (petits écrans), pub.webp (affiche).
 */
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { uriDbName } from "../src/db/connect.js";
import { SiteMedia } from "../src/models/index.js";
import { deleteStoredFile, storeFile, type StoredFile } from "../src/services/storage.js";

const [key, dir, durationArg] = process.argv.slice(2);
if (!key || !dir || !/^[a-z0-9-]{1,60}$/.test(key)) {
  console.error("Usage : npx tsx scripts/upload-site-media.ts <clé> <dossier> [durée en s]");
  process.exit(1);
}
if (!env.uploadthingToken) {
  console.error("UPLOADTHING_TOKEN manquant : les fichiers partiraient dans le dossier local, pas sur UploadThing.");
  process.exit(1);
}

// MP4 (H.264, décodé par la puce vidéo presque partout) avant WebM, petite version avant la grande.
const FILES = [
  { name: "pub-720.mp4", type: "video/mp4", height: 720, maxWidth: 900 },
  { name: "pub-720.webm", type: "video/webm", height: 720, maxWidth: 900 },
  { name: "pub.mp4", type: "video/mp4", height: 1080 },
  { name: "pub.webm", type: "video/webm", height: 1080 },
] as const;

const stamp = new Date().toISOString().slice(0, 10);
async function send(file: string, mime: string): Promise<StoredFile> {
  const data = await fs.readFile(path.join(dir, file));
  // Plusieurs essais : une connexion lente peut couper un envoi.
  for (let attempt = 1; ; attempt++) {
    try {
      const t = Date.now();
      const s = await storeFile(`pedago-${key}-${stamp}-${file}`, data, mime);
      console.log(`  ${file} : ${(data.length / 1048576).toFixed(1)} Mo en ${Math.round((Date.now() - t) / 1000)} s`);
      return s;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`  ${file} : échec (${(e as Error).message}), nouvel essai…`);
    }
  }
}

await mongoose.connect(env.mongoUri, { dbName: uriDbName(env.mongoUri) ?? env.mongoDb });
const previous = await SiteMedia.findOne({ key }).lean();

console.log(`Envoi sur UploadThing (${key})…`);
const poster = await send("pub.webp", "image/webp");
const sources = [];
for (const f of FILES) {
  const file = await send(f.name, f.type);
  sources.push({ file: { url: file.url, key: file.key, sizeBytes: file.sizeBytes }, type: f.type, height: f.height, ...("maxWidth" in f ? { maxWidth: f.maxWidth } : {}) });
}

await SiteMedia.findOneAndUpdate(
  { key },
  { key, sources, poster: { url: poster.url, key: poster.key, sizeBytes: poster.sizeBytes }, durationSec: Number(durationArg) || 60 },
  { upsert: true, new: true }
);
console.log(`Enregistré en base : SiteMedia « ${key} ».`);

if (previous) {
  for (const f of [previous.poster, ...previous.sources.map((s) => s.file)]) await deleteStoredFile(f.key, f.url);
  console.log("Anciens fichiers effacés d'UploadThing.");
}
await mongoose.disconnect();
