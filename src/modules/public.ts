import { Router } from "express";
import { SiteMedia } from "../models/index.js";
import { ah, notFound } from "../utils/http-error.js";

/** Lectures publiques (sans compte) pour le site vitrine. */
export const publicRouter = Router();

/** Adresses d'un média du site (film de présentation) : vidéos et affiche, sur UploadThing. */
publicRouter.get(
  "/site-media/:key",
  ah(async (req, res) => {
    const key = String(req.params.key);
    if (!/^[a-z0-9-]{1,60}$/.test(key)) throw notFound("Média introuvable");
    const m = await SiteMedia.findOne({ key }).lean();
    if (!m) throw notFound("Média introuvable");
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.json({
      key: m.key,
      sources: m.sources.map((s) => ({ url: s.file.url, type: s.type, height: s.height, maxWidth: s.maxWidth ?? null })),
      poster: m.poster.url,
      durationSec: m.durationSec,
      updatedAt: m.updatedAt,
    });
  })
);
