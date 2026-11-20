import { createUploadthing, type FileRouter } from "uploadthing/express";
import { UploadThingError } from "uploadthing/server";
import { Session } from "../models/index.js";
import { verifyAccessToken } from "../utils/jwt.js";

const f = createUploadthing();

/** Seuls les relecteurs et administrateurs envoient des fichiers (sources, illustrations). */
async function staffOnly({ req }: { req: { headers: { authorization?: string | string[] } } }) {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new UploadThingError("Non authentifié");
  const payload = verifyAccessToken(token);
  if (payload.role !== "admin" && payload.role !== "reviewer") throw new UploadThingError("Accès refusé");
  const session = await Session.exists({ _id: payload.sid, revokedAt: null });
  if (!session) throw new UploadThingError("Session expirée");
  return { userId: payload.sub };
}

export const uploadRouter = {
  /** Documents sources officiels (PDF) : type et taille bornés. */
  sourceDocument: f({ pdf: { maxFileSize: "32MB", maxFileCount: 1 } })
    .middleware(staffOnly)
    .onUploadComplete(({ file, metadata }) => ({ url: file.ufsUrl, key: file.key, uploadedBy: metadata.userId })),
  /** Illustrations pédagogiques. */
  illustration: f({ image: { maxFileSize: "4MB", maxFileCount: 10 } })
    .middleware(staffOnly)
    .onUploadComplete(({ file }) => ({ url: file.ufsUrl, key: file.key })),
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;
