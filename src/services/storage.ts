import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { UTApi, UTFile } from "uploadthing/server";
import { env } from "../config/env.js";

const utapi = env.uploadthingToken ? new UTApi({ token: env.uploadthingToken }) : null;
const LOCAL_DIR = path.join(process.cwd(), "exports");

export type StoredFile = { url: string; key: string; sizeBytes: number; sha256: string };

/**
 * Stocke un fichier généré : UploadThing si configuré, sinon dossier local servi par l'API (développement).
 * MongoDB ne conserve que la référence, jamais le binaire.
 */
export async function storeFile(name: string, data: Buffer, mime: string): Promise<StoredFile> {
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  if (utapi) {
    const res = await utapi.uploadFiles(new UTFile([new Uint8Array(data)], name, { type: mime }));
    if (res.error || !res.data) throw new Error(`UploadThing: ${res.error?.message ?? "échec de l'envoi"}`);
    return { url: res.data.ufsUrl, key: res.data.key, sizeBytes: data.length, sha256 };
  }
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  const key = `${sha256.slice(0, 16)}-${name.replace(/[^\w.-]/g, "_")}`;
  await fs.writeFile(path.join(LOCAL_DIR, key), data);
  const base = env.publicApiUrl || `http://localhost:${env.port}`;
  return { url: `${base}/exports/${key}`, key, sizeBytes: data.length, sha256 };
}

export const localExportsDir = LOCAL_DIR;

/** Efface un fichier stocké (UploadThing ou dossier local). Sans erreur si le fichier n'existe plus. */
export async function deleteStoredFile(key: string, url: string) {
  if (url.includes("/exports/")) {
    const local = path.join(LOCAL_DIR, path.basename(key));
    await fs.unlink(local).catch(() => undefined);
    return;
  }
  if (utapi) await utapi.deleteFiles(key).catch(() => undefined);
}
