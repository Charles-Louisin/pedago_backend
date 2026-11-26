import mongoose, { Schema } from "mongoose";

/**
 * Notification d'un utilisateur : affichée dans l'app (cloche) et envoyée en push sur son téléphone.
 * `key` rend chaque notification unique (« lesson:<id> », « bilan:<date> »…) : jamais deux fois la même.
 */
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true, maxlength: 120 },
    kind: { type: String, enum: ["lesson", "bilan", "file", "import", "info"], required: true },
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, required: true, maxlength: 400 },
    /** Écran ouvert au toucher de la notification (chemin de l'app, jamais une adresse externe). */
    href: { type: String, maxlength: 300 },
    readAt: Date,
    pushedAt: Date,
    pushError: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
notificationSchema.index({ userId: 1, key: 1 }, { unique: true });
notificationSchema.index({ userId: 1, createdAt: -1 });
// Gardées 60 jours.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 86_400 });
export const Notification = mongoose.model("Notification", notificationSchema);

/** Jeton push Expo d'un téléphone (un compte peut en avoir plusieurs ; retiré à la déconnexion). */
const pushTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true, maxlength: 200 },
    platform: { type: String, enum: ["android", "ios"], required: true },
  },
  { timestamps: true }
);
export const PushToken = mongoose.model("PushToken", pushTokenSchema);
