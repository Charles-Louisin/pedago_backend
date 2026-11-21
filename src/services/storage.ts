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

const localBase = () => `${env.publicApiUrl || `http://localhost:${env.port}`}/exports/`;
const UT_HOST = /^([a-z0-9-]+\.)?ufs\.sh$|^utfs\.io$/i;

/** Vrai si l'adresse désigne un fichier stocké par l'API (dossier local ou UploadThing), et rien d'autre. */
export function isStoredUrl(url: string) {
  if (url.startsWith(localBase())) return !url.slice(localBase().length).includes("/");
  try {
    const u = new URL(url);
    return u.protocol === "https:" && UT_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

const READ_MAX = 8 * 1024 * 1024;
/**
 * Relit un fichier stocké (image d'une fiche pour le PDF) : seulement nos propres adresses (pas de
 * requête vers une adresse choisie par un client), 5 s et 8 Mo au plus, sans redirection.
 */
export async function readStoredFile(url: string): Promise<Buffer | null> {
  if (!isStoredUrl(url)) return null;
  if (url.startsWith(localBase())) {
    const data = await fs.readFile(path.join(LOCAL_DIR, path.basename(url.slice(localBase().length)))).catch(() => null);
    return data && data.length <= READ_MAX ? data : null;
  }
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > READ_MAX) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length <= READ_MAX ? data : null;
  } catch {
    return null;
  }
}

/** Efface un fichier stocké (UploadThing ou dossier local). Sans erreur si le fichier n'existe plus. */
export async function deleteStoredFile(key: string, url: string) {
  if (url.includes("/exports/")) {
    const local = path.join(LOCAL_DIR, path.basename(key));
    await fs.unlink(local).catch(() => undefined);
    return;
  }
  if (utapi) await utapi.deleteFiles(key).catch(() => undefined);
}
