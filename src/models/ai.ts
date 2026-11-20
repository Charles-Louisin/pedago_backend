import mongoose, { Schema } from "mongoose";

export const AI_JOB_KINDS = ["build_library", "generate_resource", "review_resource", "extract_source"] as const;
export type AiJobKind = (typeof AI_JOB_KINDS)[number];

/**
 * Tâche IA durable découpée en étapes. En cas d'échec, le worker reprend à l'étape échouée.
 * Le verrou (lockedBy/lockedUntil) permet plusieurs workers concurrents sans double traitement.
 */
const stepSchema = new Schema(
  {
    name: { type: String, required: true },
    status: { type: String, enum: ["pending", "running", "done", "failed", "skipped"], default: "pending" },
    attempts: { type: Number, default: 0 },
    output: Schema.Types.Mixed,
    error: String,
    startedAt: Date,
    finishedAt: Date,
  },
  { _id: false }
);

const aiJobSchema = new Schema(
  {
    kind: { type: String, enum: AI_JOB_KINDS, required: true },
    status: { type: String, enum: ["queued", "running", "waiting_review", "done", "failed", "cancelled", "budget_exceeded"], default: "queued" },
    params: { type: Schema.Types.Mixed, default: {} },
    steps: [stepSchema],
    currentStep: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    budgetUsd: { type: Number, required: true },
    spentUsd: { type: Number, default: 0 },
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lockedBy: String,
    lockedUntil: Date,
    nextRunAt: { type: Date, default: Date.now },
    lastError: String,
    resultResourceIds: [{ type: Schema.Types.ObjectId, ref: "Resource" }],
  },
  { timestamps: true }
);
aiJobSchema.index({ status: 1, nextRunAt: 1 });
export const AiJob = mongoose.model("AiJob", aiJobSchema);

const aiUsageLogSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "AiJob", index: true },
    step: String,
    model: String,
    provider: String,
    promptVersion: String,
    tokensIn: Number,
    tokensOut: Number,
    cachedTokens: Number,
    costUsd: Number,
    latencyMs: Number,
    ok: Boolean,
    error: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
aiUsageLogSchema.index({ createdAt: -1 });
export const AiUsageLog = mongoose.model("AiUsageLog", aiUsageLogSchema);
