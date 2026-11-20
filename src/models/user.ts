import mongoose, { Schema } from "mongoose";

const userSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160 },
    phone: { type: String, trim: true, maxlength: 32 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["teacher", "reviewer", "admin"], default: "teacher", index: true },
    disabled: { type: Boolean, default: false },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    lastLoginAt: Date,
  },
  { timestamps: true }
);
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });

export const User = mongoose.model("User", userSchema);

/** Une session par appareil ; le jeton de rafraîchissement est stocké haché et tourne à chaque usage. */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    refreshHash: { type: String, required: true, unique: true },
    device: { type: String, maxlength: 120 },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    lastUsedAt: Date,
  },
  { timestamps: true }
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = mongoose.model("Session", sessionSchema);

const teacherProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    subsystem: { type: String, enum: ["francophone", "anglophone"], required: true },
    teachingLanguage: { type: String, enum: ["fr", "en"], required: true },
    schoolName: { type: String, trim: true, maxlength: 160 },
    region: { type: String, trim: true, maxlength: 80 },
    division: { type: String, trim: true, maxlength: 80 },
    schoolYear: { type: String, required: true, match: /^\d{4}-\d{4}$/ },
    /** Plusieurs classes possibles, chacune avec ses matières. */
    assignments: [
      {
        _id: false,
        classLevel: { type: String, required: true },
        subjects: [{ type: String }],
      },
    ],
    preferences: {
      difficulty: { type: String, enum: ["easy", "standard", "advanced"], default: "standard" },
      illustrationLevel: { type: String, enum: ["simple", "standard", "detailed"], default: "simple" },
      wifiOnlyDownloads: { type: Boolean, default: false },
      lowInkExports: { type: Boolean, default: true },
    },
    onboardingCompletedAt: Date,
  },
  { timestamps: true }
);
export const TeacherProfile = mongoose.model("TeacherProfile", teacherProfileSchema);

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, required: true },
    target: String,
    meta: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditLogSchema.index({ createdAt: -1 });
export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
