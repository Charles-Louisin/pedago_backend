import mongoose, { Schema } from "mongoose";

/**
 * Média du site public (le film de présentation…) : les fichiers sont sur UploadThing, la base ne garde
 * que leurs adresses. `key` désigne l'emplacement sur le site (« film »). Changer la vidéo = envoyer de
 * nouveaux fichiers avec scripts/upload-site-media.ts, sans redéployer le site.
 */
const storedSchema = new Schema(
  {
    url: { type: String, required: true, maxlength: 500 },
    key: { type: String, required: true, maxlength: 200 },
    sizeBytes: { type: Number, required: true },
  },
  { _id: false }
);

const siteMediaSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 60 },
    /** Vidéos, dans l'ordre de préférence ; `maxWidth` : écrans jusqu'à cette largeur seulement (petite version). */
    sources: [
      new Schema(
        {
          file: { type: storedSchema, required: true },
          type: { type: String, enum: ["video/webm", "video/mp4"], required: true },
          height: { type: Number, required: true },
          maxWidth: { type: Number },
        },
        { _id: false }
      ),
    ],
    poster: { type: storedSchema, required: true },
    durationSec: { type: Number, required: true },
  },
  { timestamps: true }
);

export const SiteMedia = mongoose.model("SiteMedia", siteMediaSchema);
